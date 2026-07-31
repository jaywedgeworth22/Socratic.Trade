# Sharing market data with congress.trade (App A)

**Status:** implemented (2026-06-22), **OFF by default**. See
`src/lib/congress-share.ts`, `app/api/admin/congress-share/route.ts`, and the
hooks in `src/lib/market.ts` (after-scan) and `src/lib/scheduler.ts` (nightly).

**Shared contract package (2026-06-30):** outbound import payload types, origin tags, API path constants,
and runtime Zod schemas are imported from `@jaywedgeworth22/congress-trading-shared`, with local App B
code retaining only mapping logic and operational gates.

**2026-06-25 additions (all default-OFF):**
- **Numeric analyst price targets** — `fundamentals[]`/`analyst[]` already ride the
  push via `marketQuoteToFundamentals`/`marketQuoteToAnalyst` (sourced from the scan's
  `MarketQuote`, gated `CONGRESS_SHARE_FUNDAMENTALS_ENABLED`). Their analyst numeric
  price targets (`targetMean/High/Low/Median`) were `null`; they are now filled when
  the opt-in FMP price-target provider is on (`FMP_PRICE_TARGETS_ENABLED`) — the targets
  thread through the enrichment surface onto the quote and `marketQuoteToAnalyst` emits
  them. Off → they stay `null` (App A's columns are nullable).
- **Inbound return-path receiver** — `POST /api/admin/securities/import`
  (`src/lib/securities-import-auth.ts`, `app/api/admin/securities/import/route.ts`,
  `src/lib/db-securities-import.ts`). Lands App A's gap-fill push into a local EOD
  cache; bearer `APP_B_INGEST_TOKEN`, constant-time, default-closed. Outbound pushes
  now carry `origin: app-b` so the receiver can skip a round-trip of our own rows
  (no-echo guard). The local cache feeds an opt-in `fetchDailyOHLC` tier
  (`SECURITIES_IMPORT_HISTORY_TIER_ENABLED`, density-guarded by
  `SECURITIES_IMPORT_MIN_BARS`). See the 2026-06-25 rollout note.

## Why

This app ("App B") and `congress.trade` ("App A", a Cloudflare Worker backed by a
DB) both consume **Financial Modeling Prep (FMP)**, which has a *shared daily call
quota*. App A is the shared system-of-record for company reference + daily-close
data. To stop App A from spending that quota, App B forwards the reference + price
data it already has to App A's **idempotent** import endpoint; App A upserts
`securities_ref` / `spx_eod` / `price_eod` and recomputes per-trade performance
anchors for any imported ticker.

## Important sourcing note (differs from the original brief)

The integration brief assumed App B forwards FMP `/v3/profile` and
`/v3/historical-price-full` responses "right after each FMP call." **App B does
not call those endpoints.** Its only FMP usage is the fundamentals enrichment
cascade (`/stable/ratios-ttm`, `/stable/grades-consensus`,
`/api/v4/insider-trading`, `/api/v4/senate-trading` — see
`FmpEnrichmentProvider` in `src/lib/data-providers.ts`), none of which maps to
App A's `refs` / `spx` / `prices` schema.

The data App A wants comes from App B's **other** sources:

| App A field | App B source |
|-------------|--------------|
| `refs` (partial) | `MarketQuote` from the NASDAQ screener + enrichment cascade — `companyName`, `sector`, `industry`, `marketCap` only. No CIK/exchange/country/ipoDate/sicCode. |
| `prices[].closes`, `currentPrice` | `fetchDailyOHLC()` (`src/lib/history.ts`) — Massive → Tradier → Marketstack → Yahoo → Stooq cascade. |
| `spx` | `fetchDailyOHLC("^GSPC")`. |

App A only needs the **data**, not FMP-sourced data, so forwarding App B's
Yahoo/Massive/Tradier-sourced closes still conserves App A's FMP quota. The
trigger therefore shifts from "after each FMP call" to **(a)** an after-scan refs
hook and **(b)** a nightly daily-close/SPX batch.

## What gets sent, and when

1. **After each market scan** (`scanMarket` in `src/lib/market.ts`):
   `shareScanRefs(scan)` forwards the candidate company `refs` (ticker,
   companyName, sector, industry, marketCap; `assetClass: "equity"`). Fire-and-
   forget, self-guarded, and **per-symbol throttled** (default 6h) so frequent
   scans never spam the endpoint. On a failed POST the throttle is rolled back so
   the next scan retries.

2. **Nightly batch** (`runCongressDailyShareIfDue` from the scheduler tick, at
   most once per UTC day): collects the **union of every user's watchlist symbols
   + policy-universe symbols** (the same set the filing-ingest job uses), fetches
   each ticker's daily closes (reusing the history cache) plus the `^GSPC` series,
   and POSTs them as `prices` + `spx` in capped chunks.

`refs` come from the scan hook; the nightly batch sends `prices` + `spx`. This
matches the "scan refs + nightly prices" split chosen for this work.

**Round-2 additions (2026-06-22):** the nightly batch also forwards App B's two highest-fit datasets,
sourced from its cached web-sources and built by `buildInsiderImport()` / `buildShortVolumeImport()`:
- `insider[]` — `{ ticker, date, sentiment, buyFilings, sellFilings, buyShares, sellShares, owners[] }`
  from the SEC Form-4 dataset.
- `shortVolume[]` — `{ ticker, date, ratio, elevated }` from the FINRA daily short-volume dataset.
- `prices[].closes` now also carry `volume` (App A added a `volume` slot; open/high/low stay App B-only).

These ride in the first POST of the nightly batch (with `spx`). Read back via App A's
`GET /api/market/insider/{T}` and `GET /api/market/short-volume/{T}`.

**Round-3 additions (2026-06-24):** the **after-scan hook** (`shareScanRefs`) now also forwards
`fundamentals[]` + `analyst[]` for the scanned candidates — built by `marketQuoteToFundamentals` /
`marketQuoteToAnalyst` from the `MarketQuote` data the scan already fetched (no extra FMP calls), so App A
can skip its own FMP fundamentals/analyst pulls. Shapes match App A's PR #46 import slots
(`fundamentals: {ticker,date,peRatio,eps,beta,dividendYield,week52High,week52Low,fcfYield,debtToEquity,epsGrowth}`;
`analyst: {ticker,date,rating,strongBuy,buy,hold,sell,strongSell}` — App B has no price targets, so those
are omitted). Sent in the same throttled scan-hook POST as `refs`, but **gated behind
`CONGRESS_SHARE_FUNDAMENTALS_ENABLED` (default off)** and **held until App A confirms its #46 migration is
applied** — App A's tables don't exist until then, and pushing those rows early *errors them* on App A
(the rest of the import is unaffected). `refs` keep flowing regardless; flip the flag on after App A pings.

## Safety / gating

- **Default OFF.** Automatic forwarding (both hooks) runs only when
  `CONGRESS_TRADE_TOKEN` is set **and** `CONGRESS_SHARE_ENABLED` is on
  (`isCongressShareAutoEnabled()`).
- The token is a **server-only** secret (App A's `ADMIN_TOKEN`/`INGEST_TOKEN`).
  It is read from `process.env` only and never reaches the browser or any
  dashboard snapshot. No unauthenticated write path is exposed.
- Every outbound call is self-guarded (timeout + try/catch) and **never throws**
  into a scan or scheduler tick.
- **POSTs are kept small and split per dataset** (prod hardening, 2026-06-24): App A's per-call work
  (row upserts + per-trade perf recompute) blew the timeout on big bundled payloads, so the nightly
  batch now sends `spx`, `insider` (≤500/POST), `shortVolume` (≤500/POST), and `prices` (chunked by a
  5,000-close budget + ≤100 tickers/POST) as **independent** bounded requests, caps each symbol's
  history to ~1y (`CONGRESS_SHARE_MAX_CLOSES_PER_TICKER`, default 260 — App A backfills deeper itself),
  and uses a 30s per-POST timeout (`CONGRESS_SHARE_TIMEOUT_MS`). Errors log the per-dataset `sent` counts
  for diagnosis.
- A persisted marker (`congress-share:lastDailyRunDate`) makes the nightly batch
  idempotent per UTC day.

## Congressional price-needs (performance vs S&P)

App A exposes `GET /api/export/price-needs` (same `INGEST_TOKEN` as import). The nightly
share **always** pulls a page of those tickers and merges them ahead of the monitored
universe so congressional trades missing `tx_performance` anchors get prices first.
Tickers flagged `needsDeepHistory` are sent with **full** history (not the ~1y nightly cap).

Ops one-shot deep backfill:

```http
POST /api/admin/congress-share
{ "fromAppANeeds": true, "fullHistory": true }
```

Optional: `CONGRESS_SHARE_PRICE_NEEDS_LIMIT` (default 500).

## Manual trigger (ops)

`POST /api/admin/congress-share` (admin-gated via `requireAdmin`) runs the batch
immediately, bypassing the once-per-day cadence. Requires `CONGRESS_TRADE_TOKEN`
(returns 400 otherwise) but **not** `CONGRESS_SHARE_ENABLED`.

- Body `{}` → share the monitored universe (watchlists + policy universes), recent-capped.
- Body `{ "symbols": ["AAPL","MSFT"] }` → share only those tickers (a targeted
  test that does **not** advance the daily marker).
- Body `{ "fullHistory": true }` (optionally with `symbols`) → **deep-history backfill**: send each
  symbol's FULL series (uncapped, still chunked into small POSTs) so App A can compute performance back
  to old trade dates. Run once / after adding symbols; the recurring nightly run stays recent-capped.
  See `docs/congress-trade-data-plan.md`.

Response echoes a summary: `{ ok, tickers, priced, spxRows, posts, failedPosts,
sent, responses, autoEnabled }`, where `responses` carries App A's per-POST
`{ ok, refs, spxRows, pricedTickers, priceRows, perfTickers, errors }`.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `CONGRESS_TRADE_TOKEN` | — | App A bearer token. Blank → all forwarding disabled. |
| `CONGRESS_TRADE_BASE_URL` | `https://congress.trade` | App A base URL (override for staging/local). |
| `CONGRESS_SHARE_ENABLED` | `off` | Master switch for the automatic hooks (needs the token too). |
| `CONGRESS_SHARE_MAX_TICKERS` | `2000` | Cap on the nightly universe. |
| `CONGRESS_SHARE_CONCURRENCY` | `4` | Parallel history fetches in the nightly batch. |
| `CONGRESS_SHARE_REF_TTL_MS` | `21600000` (6h) | Per-symbol scan-refs throttle. |
| `CONGRESS_SHARE_TIMEOUT_MS` | `15000` | Per-POST timeout. |

## Reverse direction (not implemented)

App A also exposes public, no-auth reads (e.g.
`GET https://congress.trade/api/analytics/ticker/{TICKER}` → a `ref` object) that
App B could consume to avoid its own lookups. Out of scope for this change.

## Tests

`test/congress-share.test.ts` (25 cases): mappers, `chunkPrices` budgeting/
truncation, the low-level POST (auth headers, body shape, skip-on-no-token, HTTP/
transport errors never throw), the scan-refs throttle + failure rollback, the
auto-enable gate, the once-per-day date gate, and the nightly batch over custom
symbols.
