# Phase 9 - Backend Web Sources (scraped / no-free-API signals)

Status: implemented 2026-06-16 (branch `web-sources`). Paper mode unchanged; these
are read-only data ingests. No trading behavior changed.

## Goal

Connect high-value signals that have **no reliable free key-based API** by reading
them server-side from public sources, on a low frequency, and feeding them to the
scoring engine, the agent prompt, and the dashboard — **without ever fabricating a
value**. If a source is down, the signal is simply absent (cells show `—`).

The headline source is **congressional trading**: politicians disclose stock trades
on a delay, and copycat retail flow tends to follow a disclosure. Surfacing fresh
disclosures lets the agent act on the same names *before* the copycats pile in.

## Architecture (`src/lib/web-sources/`)

- **`types.ts`** — `CongressTrade`, `CongressSignal`, `SymbolWebSignal`,
  `WebSourceRefreshResult`, `WebSourceConnector`.
- **`http.ts`** — polite fetch helpers: descriptive User-Agent (browser UA for
  scrape targets; SEC fair-access UA via `SEC_EDGAR_USER_AGENT`), per-request
  `AbortController` timeouts, light retry on 429/5xx, a **sequential rate limiter**
  (`runRateLimited`) so a refresh can't burst a .gov host, and cookie-jar helpers.
- **`congress.ts`** — congressional-trade ingestion. Adapters tried in order:
  1. **Senate eFD** (`efdsearch.senate.gov`) — authoritative, free, no key.
     Validated live: GET `/search/` (CSRF + cookies) → POST `/search/home/`
     (accept terms; the Django CSRF token **rotates** here) → POST
     `/search/report/data/` (PTR filings list) → GET each e-filed PTR view page →
     parse the transactions table. Parsing classifies each cell by *content*
     (ticker / date / amount / Purchase|Sale) rather than fixed column index, so
     it survives column reordering. Paper (PDF) filings are skipped.
  2. **Capitol Trades** (`bff.capitoltrades.com`) — public JSON back-end (House +
     Senate). Best-effort + configurable (`WEB_SOURCE_CAPITOLTRADES_URL`); their
     CloudFront has been flaky (503s observed), so it's a secondary.
- **`sec.ts`** — SEC EDGAR insider (Form 4) ingestion. Reads the market-wide
  "current Form 4" atom feed, resolves each filing's `index.json` → ownership XML,
  and counts **only open-market discretionary** transactions: `P` (purchase) and
  `S` (sale). Codes `M`/`A`/`F`/`G` (option exercise, grant, tax, gift) are NOT
  trading signals and are ignored. Filings accumulate into a rolling window.
- **`index.ts`** — registry + the three entry points the app uses:
  `refreshDueWebSources()` (scheduler), `getSymbolWebSignals()` (scan overlay,
  cache-only / no network), `collectEvidenceBulletins()`, `getWebSourcesStatus()`.

## Persistence + cadence

Datasets persist in the SQLite `settings` KV via `setInternalSetting` (survives
restart), each carrying its own `fetchedAt`. The scheduler tick calls
`refreshDueWebSources()` every 60s, but each connector **no-ops until its cadence
elapses** (default daily; congressional disclosures trickle in daily and getting
ahead of copycats rewards promptness). A refresh **never overwrites a good cached
dataset with nothing** on a transient outage.

Cost per refresh is small and bounded: Senate eFD ≈ 1 search + ≤80 PTR pages
(capped, rate-limited 350ms); SEC ≈ 1 feed + ≤30 filings × 2 reqs (rate-limited
250ms). Both run in the background, independent of whether autonomous trading is on.

## Wiring into the app

- **Scoring/UI/prompt** — `scanMarket` overlays `getSymbolWebSignals` onto the top
  candidates: it fills `senateTrades` (net distinct buy members − sell members)
  when a keyed provider didn't, fills `insiderSentiment` from SEC Form 4, and
  attaches `evidenceBulletins`. The Market Scan table gained a **Congress** column
  (bulletin as tooltip). The agent prompt now emits `smartMoneyEvidence` per
  candidate with guidance to treat a cluster of recent congressional/insider BUYS
  as a positioning tailwind worth front-running (and SELLS as a caution), as one
  input among many — not a standalone trigger.
- **Dashboard** — `getWebSourcesStatus()` (freshness, record counts, sources, due)
  is on the snapshot for a health indicator.

## Configuration (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `WEB_SOURCE_CONGRESS` | `on` | `off` disables the congress connector |
| `WEB_SOURCE_CONGRESS_TTL_MS` | 24h | refresh cadence |
| `WEB_SOURCE_CONGRESS_WINDOW_DAYS` | 60 | how long a trade counts toward the signal |
| `WEB_SOURCE_CONGRESS_LOOKBACK_DAYS` | 45 | how far back to pull new filings |
| `WEB_SOURCE_CONGRESS_MAX_FILINGS` | 80 | PTR pages fetched per refresh |
| `WEB_SOURCE_CAPITOLTRADES_URL` | bff default | override/disable Capitol Trades |
| `WEB_SOURCE_INSIDER` | `on` | `off` disables the SEC insider connector |
| `WEB_SOURCE_INSIDER_TTL_MS` | 24h | refresh cadence |
| `WEB_SOURCE_INSIDER_WINDOW_DAYS` | 30 | rolling window kept |
| `WEB_SOURCE_INSIDER_MAX_FILINGS` | 30 | ownership XMLs parsed per refresh |
| `SEC_EDGAR_USER_AGENT` | generic | SEC fair-access UA (set your contact) |

## Adding another source

1. Add a connector module exposing `refresh*`, `is*RefreshDue`, `get*Signals`,
   `get*Dataset`, plus pure parsers (unit-tested with captured real-shape fixtures).
2. Register it in `index.ts`: refresh in `refreshDueWebSources`, merge its
   per-symbol contribution into `getSymbolWebSignals`, add to `getWebSourcesStatus`.
3. If it produces a new numeric field, follow the enrichment add-a-field checklist
   in `docs/phase-4-market-data-scoring.md` / CLAUDE.md (interface → union →
   EMPTY_SOURCED → cascade → MarketQuote → market.ts `applyEnrichment` → summary
   projection → prompt → UI).

## Follow-ups

- SEC **8-K** material-event bulletins (cheap from the current-8-K feed + CIK map).
- Sector as a fourth learning dimension (thesis × regime × **sector** × factor) —
  needs sector threaded onto closed lots first.
- Substantially-identical / House coverage for congress once a stable free House
  feed is available (the eFD scrape is Senate-only; Capitol Trades adds House when
  its back-end is up).
- Optional providers behind paid keys (Quiver, FMP paid senate/insider) as extra
  adapters in the same connectors.
