# 2026-06-22 — Receive/consume side for congress.trade (App A)

Branch: `agent/claude-congress-share` (round 2, stacked on the round-1 push-side commit).

## Summary

Built App B's **receiving** side for the bidirectional congress.trade integration (round-1 was the
push side). Three independent, **default-OFF**, self-guarded paths:

1. **Cache-aside market reads** (`CONGRESS_TRADE_READS_ENABLED`) — `src/lib/congress-trade-client.ts`
   reads App A's `/api/market/bundle|ref|refs|prices|spx`; wired as the **first tier** of
   `fetchDailyOHLC` (`history.ts`) so App B reuses App A's EOD closes (incl. `^GSPC`) before spending
   its own keyed-history quota. Close-only → enabled charts render a line on hits (documented tradeoff).
2. **App A as congressional source** (`CONGRESS_TRADE_AS_CONGRESS_SOURCE`) — `refreshCongress`
   (`web-sources/congress.ts`) swaps its scrapers for an App A `/api/transactions` adapter (tolerant
   `coerceCongressTrade`, mapped to the confirmed App A object shape). Token-gated full feed → sends the
   shared `INGEST_TOKEN` (App B's `CONGRESS_TRADE_TOKEN`) as Bearer.
3. **Push receiver** — webhook `POST /api/webhooks/congress` (constant-time bearer
   `CONGRESS_WEBHOOK_SECRET`, default-closed; `src/lib/congress-webhook-auth.ts`) + outbound SSE
   consumer (`src/lib/congress-stream.ts`, `CONGRESS_STREAM_ENABLED`, started via `startStreams()`).
   Both feed `applyCongressEvent` (`src/lib/congress-trade-events.ts`) → existing `upsertCongressTrades`
   / `upsertInsiderFilings` → the scan's `getSymbolWebSignals` overlay. Idempotent (dedupe by event id);
   SSE resumes via `Last-Event-ID`.

App A documents to consume/implement against: `docs/push-to-app-b.md` (push contract — the file App A
reported it "could not read") and `docs/congress-trade-consume.md` (App B design).

## Method

Used two background multi-agent workflows: a 5-agent **mapping** pass (exact integration points:
dataset keys, upsert helpers, enrichment/history cascades, bootstrap/SSE/webhook patterns), then a
10-agent **adversarial review** (security / receiver / cache-aside+stream / contract+regression →
verify). All 6 verified findings were fixed (below).

## Review findings fixed (6/6 confirmed)

- **[high]** `upsertCongressTrades` accepted unparseable dates that bypassed the retention window →
  reject non-parseable dates in `coerceCongressTrade` at ingestion + retention now keeps only
  finite+recent rows.
- **[high]** `upsertCongressTrades` `added` count was wrong when retention pruned unrelated old rows →
  compute `added` from net-new dedup keys (extracted `tradeKey` helper) before pruning.
- **[medium]** chamber `includes("sen")` misclassified `representative` → `startsWith("sen")`.
- **[medium]** `coerceInsiderFiling` allowed empty `owner` → default to `"unknown"` (preserves signal).
- **[medium]** SSE messages dropped silently → log unparseable frames in the consumer loop.
- **[medium]** `seq` gap detection unimplemented vs contract → documented: recovery is via SSE
  `Last-Event-ID` resume (implemented); explicit seq-gap auto-repull deferred (code comment + doc).

## Contract alignment (from App A's round-2 answers)

`/api/transactions` object shape confirmed: `coerceCongressTrade` maps `ticker→symbol`,
`memberName/fullName→member`, `chamber`, `txType` (`P`→buy, `S`/`S_partial`→sell, others ignored),
`amountMin/amountMax`, `owner`, `txDate→tradedAt`, `filedDate→disclosedAt`. Transaction reads send the
`INGEST_TOKEN` (the public feed is 30d/50-row capped — too small for the 60–90d window).

## Files

- New: `src/lib/congress-trade-client.ts`, `src/lib/congress-trade-events.ts`,
  `src/lib/congress-webhook-auth.ts`, `src/lib/congress-stream.ts`,
  `app/api/webhooks/congress/route.ts`, `docs/push-to-app-b.md`, `docs/congress-trade-consume.md`,
  `test/congress-trade-client.test.ts`, `test/congress-trade-events.test.ts`,
  `test/congress-stream.test.ts`, this note.
- Edited: `src/lib/web-sources/congress.ts` (coercer/pull/upsert + adapter swap),
  `src/lib/web-sources/sec.ts` (insider upsert/coerce/synth), `src/lib/history.ts` (App A first tier),
  `src/lib/streams/index.ts` (start SSE consumer), `.env.example`, `STATUS.md`, `PLAN.md`.

## Verification

- `npx tsc --noEmit` — clean.
- `npm test` — **915 tests / 98 files pass** (+31 new). One flake on a first run (timing-sensitive,
  per CLAUDE.md's known flakes); passed clean on re-run.
- `npm run build` — green; `/api/webhooks/congress` + `/api/admin/congress-share` compiled.

## Status / blockers

App A's read+transactions endpoints currently **500** (prod DB not migrated; App A fixing) and
`/api/stream` isn't deployed. All consume paths are inert until those are live; enabling the flags is
safe meanwhile (every path self-guards / falls through).

## Update — round-2 contract finalized + push extended (same day)

App A confirmed the round-2 contract; applied to App B:
- **`/api/transactions` is public** (no token). `fetchAppACongressTrades` now pages the public feed
  forward via `cursor` over a rolling ~90-day window (stops at the window edge; page/row capped).
  Removed the ingest-token from transaction reads (the write token no longer rides on a public read).
- **Cache-aside `closes` carry `volume`** (`CongressClose.volume`, threaded through `ohlcBarsToCloses`
  and `appAClosesToBars`); open/high/low stay App B-only.
- **Nightly push now also sends `insider[]` + `shortVolume[]`** (App A added the import slots), built by
  `buildInsiderImport()` / `buildShortVolumeImport()` from App B's cached SEC Form-4 + FINRA datasets,
  plus `volume` on `prices[].closes`. They ride in the first POST with `spx`.
- `coerceCongressTrade` aligned to the confirmed object shape (`memberName`, `filedDate`, `txType`
  `P`/`S`/`S_partial`).
- +5 tests (volume mapping, both import builders, nightly insider/short-vol payload, public-feed no
  token-leak). **tsc clean · npm test 920 pass · build green.**

## Update — live verification + `from=` window fix (2026-06-22 PM)

App A's round-2 endpoints went live (`/api/health` → `{"db":true}`). Verified against the live service:
- Cache-aside `/api/market/prices` + `/spx` return `200` with empty `closes` (cold cache); App B's
  history tier treats that as a miss and falls through to its own providers — confirmed graceful.
- `/api/transactions` object shape matches `coerceCongressTrade` 1:1 (`ticker`/`memberName`/`chamber`/
  `txType`/`amountMin,Max`/`owner`/`txDate`; `filedDate` null → falls back to `txDate`).
- **Feed is oldest-first by `cursor_seq` = insertion order, NOT trade-date** (`since=7100` returns 2012
  rows). So `fetchAppACongressTrades` now bounds the window with App A's documented `?from=` param
  (`from = today − (windowDays + 7)`) and pages forward — replacing the earlier (incorrect) cursor
  early-break. `from=` filtering verified live (`from=2020-11-15` correctly drops the 2020-11-10 row).
  +`from`/`to` added to the read client + a windowed-pull test. tsc clean · npm test 921 pass · build green.

**Important:** App A's `/api/transactions` currently holds only seed/historical data (mostly 2012–2020;
`from=2026-01-01` → `total:1`, null ticker). **Keep `CONGRESS_TRADE_AS_CONGRESS_SOURCE` OFF** until App A
ingests current disclosures — switching now would replace App B's working scrapers with stale data. The
cache-aside reads + nightly push are safe to enable now (they fall through / populate on cold cache).

## Follow-ups

- Enable `CONGRESS_TRADE_READS_ENABLED` + `CONGRESS_SHARE_ENABLED` now (safe; warms as backfill runs);
  enable `CONGRESS_TRADE_AS_CONGRESS_SOURCE` only once `GET /api/transactions?from=<today-7d>` returns
  real recent rows.
- **High-value next (proposed):** consume App A's analytics — member track-record weighting
  (`/api/analytics/member-leaderboard`, `/member/:filerId`), cluster-buys (`/cluster-buys`), and
  per-trade performance (`/performance/:txId`) — to make App B's congressional signal far smarter than
  its current equal-weight distinct-member netSignal. See the round-2 evaluation.
- Optional: explicit seq-gap auto-repull once App A ships the SSE 24h backlog (today: Last-Event-ID resume).
