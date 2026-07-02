# 2026-07-02 — /console/scan: Market Scan table + Smart Money (parity-port Wave 2, Claude)

Branch: `claude/console-scan` (cut from `origin/main` @ 48fbe14, i.e. after the Wave-1
foundation PR #321 landed).

## Summary

Built the **Scan destination** of the console parity port: `/console/scan`, the route the
Wave-1 nav already pointed at. One page, two tabs:

1. **Market scan** — a sortable table of the scan's `topCandidates` (Symbol w/ `TickerLogo`
   + `SymbolButton` drilldown, Score, Price, Chg, Vol, P/E, EPS growth, Dividend yield,
   Sentiment, Analyst rating, Congress net, Sector). Every header and cell carries a
   plain-language tooltip; cell tooltips include per-field provenance strictly from
   `quote.sources` (`EnrichmentSources`) via `friendlySource` — never a hardcoded provider —
   plus a "Received …" stamp (scan-level `generatedAt` when the field's own tooltip doesn't
   already carry one). P/E follows the repo rule: `n/a` = `eps <= 0` (real computed
   no-ratio), `—` = data unavailable. A "held" chip marks candidates with
   `positionMarketValue > 0`. Sorting: click headers, missing values last in both
   directions, `aria-sort` set. Mobile: horizontal scroll with a **sticky symbol column**
   whose cell re-derives the row-hover wash (group-hover on an opaque
   `color-mix(--con-fg 6%, --con-surface)` background) so hover stays uniform.
2. **Smart money** — the full cached congressional-trade + insider (Form 4) datasets from
   `snapshot.smartMoney`, with feed metadata (record counts, source labels derived from
   `webSources.*.sources`, fetched-at freshness) from `snapshot.webSources`. Rows use
   `.con-row` hover, BUY/SELL/MIXED chips, `SymbolButton` drilldown, disclosed amount
   bands (congress) / buy-sell transaction counts (insider), UTC-safe date rendering.

**Refresh**: "Refresh scan" calls `GET /api/scan` (the route is a GET, not a POST — it runs
a fresh read-only scan server-side) with a spinner/busy state, success toast (candidates,
scanned symbols, elapsed seconds) or failure toast + a muted inline notice that never
contradicts a populated table (the last good scan stays up). The page auto-fetches once on
mount (matching legacy `MarketScanView`), and the table always shows the **newest** of
{page's own refresh, `snapshot.latestStrategyRun.marketScan`} by `generatedAt`, labeled
with an honest freshness chip ("fresh" vs "last run", "· cached" when applicable).
`MarketScan.source` is displayed as derived from the `+`-joined string
(`formatSourceList`), with the raw string verbatim in the tooltip. Scan warnings render as
a warn-toned notice. Empty states: no scan yet → explanation + "Run scan" button; scan ran
but zero candidates → universe guidance. Light + dark come free from `--con-*` tokens.

## Why

Wave-2 of the multi-agent legacy→console parity port (see
`docs/rollouts/2026-07-02-console-port-foundation.md`). Scan/Smart-Money existed only in
the legacy dashboard (`MarketScanView` / `SmartMoneyView` in `app/dashboard-client.tsx`);
the console nav already linked `/console/scan` as a dead route. Improvements over legacy:
honest newest-scan selection (a strategy run finishing after a manual refresh wins),
missing-last sorting in both directions, sticky identity column on mobile, smart-money
amount bands + insider tx counts surfaced, and toast-based refresh feedback.

## Files

- `app/console/scan/page.tsx` (NEW) — page, tabs, header, refresh action, empty/error states.
- `app/console/scan/scan-table.tsx` (NEW) — sortable table, sticky symbol column, tooltip stamping.
- `app/console/scan/columns.tsx` (NEW) — column defs, per-field provenance tooltips, P/E rule,
  sentiment/rating chips (reuses `sentimentTitle`/`ratingTitle`/`friendlySource`/`receivedLabel`
  from `src/lib/dashboard-ui.ts` — imported, not modified).
- `app/console/scan/smart-money.tsx` (NEW) — congress + insider cards.
- `app/console/scan/use-live-scan.ts` (NEW) — GET /api/scan hook (abortable, supersede-safe,
  discriminated refresh outcome, `newestScan`).
- `STATUS.md`, `PLAN.md`, `docs/rollouts/2026-07-02-console-scan.md` — handoff docs.

Deliberately untouched (parallel-agent collision constraints): `app/console/console.css`,
`app/console/components/nav.tsx`, `app/console/lib/api.ts`, all other console destinations,
and everything under `src/lib/`.

## Verification

Run in this worktree (fresh `npm ci`, 754 packages):

```bash
npx tsc --noEmit    # clean
npm run lint        # exit 0 — 0 errors; only 2 warnings in new files, both the
                    # grandfathered react-hooks/set-state-in-effect fetch-on-mount idiom
                    # (same pattern as app/console/lib/useConsoleData.tsx)
npm test            # 2241 tests / 234 files, all pass
npm run build       # ok; /console/scan present in the route list (static)
```

Runtime smoke test (production `next start` on a scratch port): `/console/scan` → 200 and
renders the console shell; `GET /api/scan` → real payload (`source:
"nasdaq-delayed-screener+yahoo-finance+congress+congress.trade+finra"`, 501 quotes, 38
candidates incl. 8 outliers, per-field `sources` populated) — confirms the table's field
mapping against live data. Note for other agents: ports 3123 etc. may be occupied by
OTHER worktrees' smoke servers — first attempt on 3123 accidentally hit a sibling agent's
server (hence its 404 for this route); re-ran on a unique port and killed only my PID.

## Follow-ups

- The drilldown sheet resolves quotes from `latestStrategyRun.marketScan.quotesBySymbol`,
  so a symbol only present in a page-refreshed scan shows `—` for its stats (degrades
  honestly). Wiring the live scan into the drilldown would need a change to the shared
  `symbol-drilldown.tsx` (not owned by this branch).
- Column show/hide + persisted order (legacy `SCAN_COLS_KEY` chooser) was intentionally
  dropped for a curated 12-column set; add back if the owner misses it.
- Legacy derived columns (PEG, vs VWAP, spread bps, Graham MoS, …) from
  `src/lib/derived-metrics.ts` are not in the console table yet — candidates for a
  "more columns" follow-up.
- `/api/scan` is rate-limited (30/min/user); the hook surfaces the server's 429 message.
