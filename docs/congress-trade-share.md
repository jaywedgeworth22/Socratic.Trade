# Sharing market data with congress.trade (App A)

**Status:** implemented (2026-06-22), **OFF by default**. See
`src/lib/congress-share.ts`, `app/api/admin/congress-share/route.ts`, and the
hooks in `src/lib/market.ts` (after-scan) and `src/lib/scheduler.ts` (nightly).

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

## Safety / gating

- **Default OFF.** Automatic forwarding (both hooks) runs only when
  `CONGRESS_TRADE_TOKEN` is set **and** `CONGRESS_SHARE_ENABLED` is on
  (`isCongressShareAutoEnabled()`).
- The token is a **server-only** secret (App A's `ADMIN_TOKEN`/`INGEST_TOKEN`).
  It is read from `process.env` only and never reaches the browser or any
  dashboard snapshot. No unauthenticated write path is exposed.
- Every outbound call is self-guarded (timeout + try/catch) and **never throws**
  into a scan or scheduler tick.
- Array sizes are capped to the endpoint's limits (≤ ~2,000 tickers / ≤ ~20,000
  closes per call): `chunkPrices()` packs by both a close budget (18,000/POST)
  and a ticker count, truncating any single oversized ticker to its most-recent
  closes.
- A persisted marker (`congress-share:lastDailyRunDate`) makes the nightly batch
  idempotent per UTC day.

## Manual trigger (ops)

`POST /api/admin/congress-share` (admin-gated via `requireAdmin`) runs the batch
immediately, bypassing the once-per-day cadence. Requires `CONGRESS_TRADE_TOKEN`
(returns 400 otherwise) but **not** `CONGRESS_SHARE_ENABLED`.

- Body `{}` → share the monitored universe (watchlists + policy universes).
- Body `{ "symbols": ["AAPL","MSFT"] }` → share only those tickers (a targeted
  test that does **not** advance the daily marker).

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
