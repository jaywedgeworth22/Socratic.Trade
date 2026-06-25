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

- App A's `closes` now include `volume`, so App B's bars carry close+volume (still no open/high/low).
- **Tradeoff:** App A returns close(+volume) only, so an enabled price chart renders a line (no candles)
  on App A cache hits. Contained to opt-in; default off → existing OHLC behavior unchanged.
- Self-guarded: disabled / miss / non-2xx / transport error → returns null → the cascade falls through to
  App B's own providers. No exceptions escape into a scan.
- Deliberately **not** wired into the enrichment cascade: App A's `ref` fields (sector/industry/marketCap)
  are already free-sourced via Yahoo in App B and don't displace App B's *FMP fundamentals* calls
  (ratios/grades), so it would be marginal value for the multi-site `SymbolEnrichment` field-plumbing risk.

## 2. App A as the congressional source (`CONGRESS_TRADE_AS_CONGRESS_SOURCE`)
When on, `refreshCongress` (`src/lib/web-sources/congress.ts`) swaps its scraper cascade (Senate eFD /
Apify / Capitol Trades) for a single App A adapter, `fetchAppACongressTrades`, that pulls App A's
**public** `/api/transactions` feed (no token). The feed is **oldest-first by `cursor_seq`
(insertion order, NOT trade-date order)**, so the pull bounds the window server-side with
`?from=<today − (signal window + 7d)>` (App A's documented rolling-window param) and pages forward via
`cursor` until the window is exhausted (page/row capped). `coerceCongressTrade` maps App A's confirmed
fields (`ticker→symbol`, `memberName/fullName→member`, `txType` `P`→buy / `S`,`S_partial`→sell,
`amountMin/Max`, `owner`, `txDate→tradedAt`, `filedDate→disclosedAt`; `filedDate` may be null → falls
back to `txDate`) and rejects unparseable dates. A 0-result pull keeps the prior dataset (never wipes).

> **Do not enable this flag until App A's feed carries CURRENT disclosures.** As of 2026-06-22 App A's
> `/api/transactions` is still seed/historical (mostly 2012–2020; `from=2026-01-01` → `total:1` with a
> null ticker). Switching the source now would replace App B's working scrapers (which fetch current
> disclosures) with stale data — a regression. The flag + `from=` pull are validated live; just keep it
> OFF until `GET /api/transactions?from=<today-7d>` returns real recent rows.

## 3. App A analytics overlay — the "Trends" composite (`CONGRESS_ANALYTICS_ENABLED`)
App A computes aggregate congressional analytics App B can't derive from raw trades — its public
"Trends" page (dollar-weighted net flow, distinct-member counts, cluster buys, member track-record).
`src/lib/web-sources/congress-analytics.ts` refreshes these daily (`getAppATickerLeaderboard` +
`getAppAClusterBuys` + `getAppAMemberLeaderboard`, `?window=90d`), persists a per-symbol overlay, and
`getSymbolWebSignals` attaches it as `SymbolWebSignal.congressAnalytics`. `outlierInterestScore`
(`market.ts`) then folds it into scan candidate selection via `congressAnalyticsScore`: a strong
**dollar net buy flow** + **cluster buy** + **multiple high-track-record members** can surface a name
even when the scraped per-member `netSignal` is thin. Net-selling/neutral contributes 0 (long-side
only). Additive + default-off → no behavior change when off.

**Member quality — real skill, with an activity fallback (2026-06-25).** App A now exposes
`GET /api/analytics/member/:filerId/performance` → `{performance:{tradeCount, scoredCount, winRate,
medianReturn, medianExcess, avgReturn, avgExcess}}`, where `avgExcess`/`medianExcess` are realized
return **in excess of the S&P** (alpha). `buildMemberSkillScores` (in `congress-analytics.ts`) fetches
this for the filerIds surfaced in cluster `topMembers` (bounded by `MAX_SKILL_LOOKUPS=200`,
`getAppAMemberPerformance` in the read client) and rank-normalizes by alpha (→ 0–100, keyed by
**filerId**), ranking only members with `scoredCount > 0`. The cluster `topMemberScore` prefers this
real skill score and **falls back** to `buildMemberScores` (activity prominence — `estVolumeUsd`/
`tradeCount`, keyed by name) when a member has no scored performance yet. App A returns nulls until a
member's trades are scored (which needs the price push to fill in), so this lights up gradually — until
then the activity proxy carries it. No extra calls when there are no clusters.

## 4. Push receiver — webhook + SSE
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
App A's round-2 endpoints are **merged** and go live after its next deploy (a pending prod DB migration).
**Wait until `GET https://congress.trade/api/health` returns `{"db":true}` before enabling the flags.**
Until then every consume path self-guards / falls through, so enabling early is harmless but inert.

Confirmed contract deltas applied here: the `/api/transactions` feed is **public** (no token); `closes`
carry `volume`; and App B's nightly push now sends `insider[]` + `shortVolume[]` (App A added those import
slots) — see `docs/congress-trade-share.md`.
