# App B → App A: full coordination note (2026-06-22)

Paste-ready status + asks + offers between App B (the trading app) and App A (congress.trade). Covers
everything App A may want to know, can help us with, or can get help from us with.

## 1. Status — what App B has shipped
- **Push (B→A), default-off:** company `refs`, daily `prices` (close **+ volume**), `spx`, `insider[]`
  (SEC Form-4), `shortVolume[]` (FINRA) → `POST /api/admin/securities/import` (nightly + after-scan refs).
- **Cache-aside reads (A→B), default-off:** `/api/market/prices` + `/spx` as App B's first history tier;
  cold-cache → graceful fall-through (live-verified).
- **Congress source (A→B), default-off:** App B can source disclosures from your public
  `/api/transactions` using `?from=<today-90d>` (your rolling-window param — thanks; works great).
- **Analytics overlay (A→B), default-off — NEW:** App B now consumes your **Trends composite**
  (`/api/analytics/ticker-leaderboard`, `/cluster-buys`, `/member-leaderboard`, `?window=90d`) and folds
  dollar net flow + cluster buys + member track-record into its scan scoring. **So any enrichment you do
  on Trends/analytics directly makes App B smarter.**
- **Push receiver (A→B):** `POST /api/webhooks/congress` (bearer) + an SSE consumer of `/api/stream`
  (sends `Last-Event-ID`).

## 2. The #1 thing App A can do for us: ingest CURRENT disclosures
Your `/api/transactions` is still seed/historical — `from=2026-01-01` → `total:1` (null ticker); analytics
windows are near-empty. Until real recent disclosures land, App B's congress-source + analytics overlay
have nothing to work with, so we're keeping `CONGRESS_TRADE_AS_CONGRESS_SOURCE` / `CONGRESS_ANALYTICS_ENABLED`
**off** (switching now would replace App B's working scrapers with stale data). Everything is wired and
live-verified — it lights up the moment your ingestion is current.

## 3. Questions we need answered to finish wiring
- **Member-leaderboard performance field:** App B rank-normalizes member quality but the numeric field
  name isn't fixed. What does each `/member-leaderboard` row expose — `medianReturnPct`? `winRate`?
  `avgReturnPct`? (We try those names; tell us the real one.)
- **Cluster-buys shape:** do `/cluster-buys` rows include `ticker` + `topMembers[{memberName}]`? App B
  keys member-quality off that.
- **`cursor` type:** it's numeric (`cursor_seq`); App B handles it, just confirming it stays numeric.

## 4. What App A could newly GET from App B (offers)
You FMP-enrich yourself, so receiving these from us **saves your FMP quota** (the project's whole point)
and enriches your ticker pages. If you add import slots (mirroring `prices[]`), App B will push on the
nightly batch:
- **Fundamentals:** `{ ticker, date, peRatio, eps, beta, dividendYield, fiftyTwoWeekHigh, fiftyTwoWeekLow,
  fcfYield, debtToEquity, epsGrowth }`
- **Analyst consensus:** `{ ticker, date, rating, score (0-100), buy/hold/sell counts }`
- (Lower priority) **Macro regime snapshot** per day (`VIX`, market breadth%) to annotate trade
  performance with market context; **news sentiment** per ticker.
Tell us the slot field names and we wire the push.

## 5. What App B would like to GET MORE of from App A (asks)
- **`/performance/:txId`** (per-trade realized performance) → feed App B's learning loop (did
  congressional signals actually pay off).
- **Embedded ref fields** already on `/transactions` rows (`refSector`/`refMarketCap`/…) → free ref
  enrichment once warm.
- **Richer transaction fields** we currently drop: `confidence` (confidence-weight signals),
  `capGainsOver200`, `isOption` (App B is equity-only — lets us filter options).
- **`/filing-lag`, `/trending`, `/sector-breakdown`, `/party-split`** → secondary context for the agent.

## 6. SSE 24h backlog (you offered to build it on `claude/sse-backlog`)
Yes please — App B already sends `Last-Event-ID` on reconnect, so once you replay `cursor_seq > id`
before the live tail, resume is gap-free. Keep ~24h retention. Until then App B leans on the webhook
(which you retry) where gap-free delivery matters.

## 7. FYI / non-blocking
- App B populates your cache via the **nightly batch + your backfill**, not synchronous per-read
  push-back (no read-path latency). Flag if you specifically want inline push-back.
- App B consumes `/api/market/prices` + `/spx` + `/transactions` + `/api/analytics/*`. It does **not**
  read `/api/market/ref` or `/bundle` (refs are free-sourced locally), so `ref:null`/404 there is moot.
