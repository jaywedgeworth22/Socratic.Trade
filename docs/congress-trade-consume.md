# Consuming congress.trade (App A) data — the receiving side

**Status:** implemented (2026-06-22), **all paths default OFF**. Complements the push side
(`docs/congress-trade-share.md`) and the push contract App A implements (`docs/push-to-app-b.md`).

App A (congress.trade) is the system-of-record for congressional disclosures and also pulls FMP. App B
consumes App A so it spends the shared FMP quota once and can retire its own scrapers. Three independent,
flag-gated paths:

## 1. Cache-aside market reads (`CONGRESS_TRADE_READS_ENABLED`)
`src/lib/congress-trade-client.ts` reads App A's public endpoints (`/api/market/bundle|ref|refs|prices|spx`).
Wired as the **first tier** of `fetchDailyOHLC` (`src/lib/history.ts`): App B reuses App A's EOD closes
before calling its own keyed history providers (Massive/Tradier/Marketstack), saving that quota. `^GSPC`
flows through the same path via `/api/market/spx`.

- **Tradeoff:** App A returns close-only series, so an enabled price chart renders a line (no candles) on
  App A cache hits. Contained to opt-in; default off → existing OHLC behavior unchanged.
- Self-guarded: disabled / miss / non-2xx / transport error → returns null → the cascade falls through to
  App B's own providers. No exceptions escape into a scan.
- Deliberately **not** wired into the enrichment cascade: App A's `ref` fields (sector/industry/marketCap)
  are already free-sourced via Yahoo in App B and don't displace App B's *FMP fundamentals* calls
  (ratios/grades), so it would be marginal value for the multi-site `SymbolEnrichment` field-plumbing risk.

## 2. App A as the congressional source (`CONGRESS_TRADE_AS_CONGRESS_SOURCE`)
When on, `refreshCongress` (`src/lib/web-sources/congress.ts`) swaps its scraper cascade (Senate eFD /
Apify / Capitol Trades) for a single App A adapter that pulls `/api/transactions` and coerces rows into
App B's `CongressTrade` shape (`coerceCongressTrade` is tolerant of App A's not-yet-finalized field names).
A 0-result pull keeps the prior dataset (never wipes). Requires the transactions feed to be reachable.

## 3. Push receiver — webhook + SSE
App A pushes events (see `docs/push-to-app-b.md`); both transports feed the same handler,
`applyCongressEvent` (`src/lib/congress-trade-events.ts`), which upserts into App B's existing persisted
web-source datasets so the scan's `getSymbolWebSignals` overlay serves them unchanged.

- **Webhook:** `POST /api/webhooks/congress`, bearer-verified constant-time against `CONGRESS_WEBHOOK_SECRET`
  (`src/lib/congress-webhook-auth.ts`; default-closed when unset). Accepts one envelope or `{events:[...]}`.
- **SSE:** `src/lib/congress-stream.ts` connects out to App A's `/api/stream` (started from `startStreams()`
  when `CONGRESS_STREAM_ENABLED` is on), with a tested incremental frame parser, reconnect/backoff, and
  `Last-Event-ID` resume.
- **Idempotency:** events deduped by `id` (bounded in-memory set). `congress.trade` → `upsertCongressTrades`
  (deduped + pruned to 120d); `insider.update` → raw Form-4 filings *or* a precomputed `insiderSentiment`
  scalar (synthesized into a marker filing); `ref.upsert`/`price.eod`/`spx.eod` are acknowledged no-ops
  (App B consumes those lazily via the read client).

## Config (all default off)
| Env var | Purpose |
|---------|---------|
| `CONGRESS_TRADE_READS_ENABLED` | cache-aside market reads (history tier) |
| `CONGRESS_TRADE_AS_CONGRESS_SOURCE` | source congressional trades from App A instead of scrapers |
| `CONGRESS_WEBHOOK_SECRET` | shared bearer App A presents to the webhook (default-closed when blank) |
| `CONGRESS_STREAM_ENABLED` | start the outbound SSE consumer |
| `CONGRESS_TRADE_BASE_URL` | App A base (shared with the push side) |
| `CONGRESS_TRADE_READ_TOKEN` | optional bearer for App A reads/SSE (reads are public) |
| `CONGRESS_STREAM_PATH` | App A SSE path (default `/api/stream`) |

## Status of App A's endpoints (2026-06-22)
App A's home page is live, but its read endpoints (`/api/market/*`, `/api/transactions`) currently return
HTTP 500 and `/api/stream` is not yet deployed. So all consume paths are built and tested but **inert until
App A ships those endpoints**; enabling the flags is safe meanwhile (every path self-guards / falls through).
