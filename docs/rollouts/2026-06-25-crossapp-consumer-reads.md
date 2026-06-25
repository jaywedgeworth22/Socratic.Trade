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

## Deeper saving — opt-in short-circuit (NEW)
Implemented the actual paid-call elimination, opt-in: `ENRICHMENT_SHORT_CIRCUIT_ENABLED` (+
`CONGRESS_TRADE_READS_ENABLED`). The cascade now runs the **free** providers first, then **skips the paid
fundamentals providers' fetch for any symbol App A FULLY covered**. Price still comes from the free tier
(Alpaca/Yahoo) and App A's row carries the rest, so covered symbols lose nothing. Paid providers are tagged
`costTier: "paid"`; the merge stays in registration order so field precedence is identical. **Default OFF**
→ existing behavior unchanged, +3 tests cover the covered/partial/off paths. Also: App A misses are now
**negative-cached** for 1h so uncovered symbols aren't re-fetched every scan (Codex P2).

## Codex review round 2 (PR #160, commit fcf7db9)
- **P2 invalid App A numerics (line 425)** — App A stores `0`/negative as a "no value" sentinel for P/E and
  52-week high/low. The mapping now drops them (`peRatio > 0`, `week52High/Low > 0`) so a sentinel never
  overrides a real paid-provider value. Other scalars (eps, beta, etc.) keep the plain null check.
- **P2 too-weak coverage criterion (line 607)** — the short-circuit `covered` predicate required only
  `peRatio` + `eps`, so a symbol with a partial App A row would skip the paid tier and silently lose
  `beta`/`fcfYield`/`debtToEquity`/`epsGrowth`/analyst. Strengthened to require the **full** set those paid
  providers supply (the six fundamentals + `analystRating` or `targetMean`) before excluding a symbol;
  partial rows fall through to paid. Docs (`congress-trade-consume.md` §1b + config table) updated to match.

## Codex review round 3 (PR #160, commit 87cefe3) — short-circuit correctness rework
Two more P2s, both valid and related (App A's enrichment derives from the *same* upstream providers):
- **P2 lost fields (line 627)** — the whole-provider skip dropped fields the bundled paid providers
  *also* supply but App A never does: Finnhub/Alpha-Vantage **news+sentiment**, FMP **insider/senate**,
  Intrinio/Tiingo/TwelveData **quote** fields. "Nothing is lost" was false. **Reworked**: no whole
  provider is skipped anymore. The cascade now passes paid providers an `EnrichmentContext`
  (`coveredFields[symbol]` = the set of fields App A filled); a provider skips only the redundant
  **sub-calls**. Implemented for **FMP** — when App A has P/E it skips `ratios-ttm`, when App A has analyst
  it skips `grades-consensus`, but always fetches `insider-trading`/`senate-trading`. Providers that ignore
  the hint are unchanged. Real call savings, zero field loss.
- **P2 double-counted analyst (line 455)** — when App A's analyst row originated from FMP/Finnhub/Yahoo,
  keying it under `congress.trade` made the cascade blend the *same* consensus as two independent votes,
  skewing `analystScore`. **Fixed**: key App A's `analystBySource` entry under its upstream `source`
  (e.g. `fmp`) when present, so `Object.assign` dedupes it against the direct provider when that provider
  also runs; fall back to `congress.trade` only when the source is unknown.
- Tests reworked to assert the new sub-call behavior (paid provider always runs, receives the hint,
  preserves its unique insider/senate fields for covered symbols). Docs: `congress-trade-consume.md` §1b +
  config table. tsc clean, data-providers 51/51.

## Follow-ups
- Enabling in prod: `CONGRESS_TRADE_READS_ENABLED=on` (reads + the new fundamentals tier), optionally
  `ENRICHMENT_SHORT_CIRCUIT_ENABLED=on` (skip paid for App-A-covered symbols), plus the B→A push flags
  (`CONGRESS_SHARE_ENABLED` + `CONGRESS_TRADE_TOKEN`) so App A's tables fill — owner/infra action.
- The A→B nightly-push **receiver route already exists** (`app/api/admin/securities/import/route.ts`).
  Wiring done 2026-06-25: `APP_B_IMPORT_URL` + `APP_B_INGEST_TOKEN` set on App A (Congress.Trade Worker
  secrets). App B still needs the **same `APP_B_INGEST_TOKEN`** + `SECURITIES_IMPORT_HISTORY_TIER_ENABLED`.
