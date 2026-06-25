# 2026-06-25 — Cross-app consumer reads (fundamentals/analyst from Congress.Trade)

## Summary
Added the App B (agentic-trading) consumer half of the cross-app fundamentals/
analyst data-sharing. Congress.Trade (App A) now exposes
`GET /api/market/fundamentals/:ticker` and `/api/market/analyst/:ticker` (it
already stored these — written by our own donated push + its enrichment — but had
no reader, so App B kept re-paying providers for data App A had). This wires App B
to read them.

## Why
Lower duplicate paid-provider calls and keep fundamentals/analyst numbers
consistent between the two apps. App A's data covers the full congressional
ticker universe and is free to read.

## Files
- `src/lib/congress-trade-client.ts` — new `getAppAFundamentals()` /
  `getAppAAnalyst()` (mirror `getAppAPrices`; gated by `congressReadsEnabled()`),
  plus `AppAFundamental` / `AppAAnalyst` types.
- `src/lib/data-providers.ts` — new `CongressTradeEnrichmentProvider` (name
  `congress.trade`) mapping the latest App A fundamentals + analyst row onto the
  existing `SymbolEnrichment` fields (peRatio, eps, beta, dividendYield,
  fiftyTwoWeekHigh/Low, fcfYield, debtToEquity, epsGrowth, targetMean/High/Low/
  Median, analystRating/Score/BySource). Registered in `getEnrichmentProvider`
  ahead of the paid fundamentals providers, **gated by `CONGRESS_TRADE_READS_ENABLED`**
  (default OFF). Supplies only fundamentals/analyst (no price), so real-time quote
  ordering is unchanged. No new `SymbolEnrichment` field → no cross-file field
  plumbing needed.

## Verification
- `npx tsc --noEmit` — clean.
- `npm test` — 1184 tests pass (132 files).
- `npm run build` — succeeds.

## Codex review response (PR #160)
- **P1 docs** — updated `PLAN.md` + `docs/congress-trade-consume.md` (§1b) to cover this tier.
- **P2 rating-only rows** — the cascade derives the displayed rating from `analystBySource`, not the
  `analystRating` scalar, so a rating-only App A row was dropped. Fixed: derive a score from the label
  (`scoreFromAnalystLabel`) and write `analystBySource`.
- **P2 caching** — reads now use the shared 6h enrichment cache
  (`readEnrichmentCache`/`writeEnrichmentCache`, prefix `congress.trade`); hits short-circuit before HTTP.
- **P2 stale rows** — freshness guard `CONGRESS_TRADE_MAX_STALE_DAYS` (default 21): an App A row is used
  only if `updatedAt`/`date` is within the window, else it falls through to fresh paid providers.

## Follow-ups
- The cascade runs providers in parallel (first-wins merge): this gives App A's data **precedence** and
  (via caching) stops re-hitting App A, but does NOT eliminate a paid provider's fetch — each paid
  provider fetches a mixed price+fundamentals bundle per symbol, so you can't skip it for a symbol without
  losing the price it also supplies. The real call-elimination lever is operational: drop a redundant
  *paid fundamentals* provider once App A coverage is trusted.
- Enabling it in prod is a flag flip (`CONGRESS_TRADE_READS_ENABLED=on`) plus the
  B→A push flags (`CONGRESS_SHARE_ENABLED` + `INGEST_TOKEN`) so App A's tables fill
  — owner/infra action.
- The A→B nightly-push **receiver route already exists** (`app/api/admin/securities/import/route.ts`,
  built 2026-06-25 — the earlier "missing" finding was a wrong-path search under `src/app`). Activating
  that direction is config only: `APP_B_IMPORT_URL` + `APP_B_INGEST_TOKEN` on App A, and
  `APP_B_INGEST_TOKEN` + `SECURITIES_IMPORT_HISTORY_TIER_ENABLED` on App B.
