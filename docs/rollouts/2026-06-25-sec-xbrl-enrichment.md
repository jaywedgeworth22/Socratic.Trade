# 2026-06-25 — SEC EDGAR XBRL company-facts enrichment provider (keyless, default-OFF)

Branch: `claude/sec-xbrl-enrichment` (off `origin/main`). Final clean/additive backlog
item. Implemented by a Sonnet subagent against a tight spec; reviewed + verified by the
Opus main agent (full tsc/test/build trio + code read of the parse + cascade wiring).

## Summary

A keyless, default-OFF enrichment provider that fills the EXISTING `SymbolEnrichment`
field `debtToEquity` from authoritative SEC filings via the public companyfacts API
(`https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`). (EPS was also filled
in rounds 1–2 but was **dropped in round 3** — see that note below — because annual 10-K
EPS isn't the TTM figure `SymbolEnrichment.eps` documents.)

- **No new field threading** — it only populates fields that already exist on
  `SymbolEnrichment`/`MarketQuote`, so the cross-file enrichment surface
  (`EnrichmentSourcedField`/`EMPTY_SOURCED`/`MarketQuote`/`market.ts`) is untouched.
- **Reuses existing SEC plumbing:** `secUserAgent()` + `politeFetchText` + `runRateLimited`
  (300 ms polite inter-request delay) from `web-sources/http`, and `loadCikMap` (ticker↔CIK,
  7-day cached) + `padCik`. Cascade order: after FMP (paid key wins), before Yahoo
  (so authoritative SEC data supersedes Yahoo's scrape when enabled).
- **Pure, tested parse:** `parseCompanyFacts(json)` picks the latest `10-K` entry (falls
  back to any form), computes `debtToEquity = Liabilities / StockholdersEquity` only when
  equity > 0, and prefers `EarningsPerShareDiluted` over `…Basic`. Defensive throughout —
  unknown/garbage shapes return `{}`, never throws.
- **Default OFF:** inert unless `SEC_XBRL_ENRICHMENT_ENABLED` is set. 24 h cache (filings
  move slowly). Per-symbol errors degrade to `{}` (the cascade falls through to Yahoo).

## Files

- `src/lib/data-providers.ts` — `secXbrlEnrichmentEnabled()`, exported pure
  `parseCompanyFacts`, `SecXbrlEnrichmentProvider`, cascade registration in
  `getEnrichmentProvider`.
- `.env.example` — `SEC_XBRL_ENRICHMENT_ENABLED=off`.
- `test/sec-xbrl.test.ts` (new, 23 cases) — D/E from latest 10-K + rounding, diluted-over-basic
  EPS, latest-date + 10-K-preference selection, zero/negative-equity omission, null/garbage
  tolerance, and the env-flag parsing.

## Verification (main-agent, full trio)

```
npx tsc --noEmit   # clean
npx vitest run     # 1136/1137 (+23); only the pre-existing cache-provenance date flake
npm run build      # compiles green
```

Reviewed: `padCik` strips non-digits + pads to 10 (URL `CIK0000320193.json` correct);
`loadCikMap` returns `String(Number(cik))` → reversed map + `padCik` is correct; the shared
module `cache` map + `runRateLimited(items, delayMs, fn)` signatures match.

## Operator

Set `SEC_XBRL_ENRICHMENT_ENABLED=on` to enable. Optionally set `SEC_EDGAR_USER_AGENT` to a
real contact string (SEC fair-access). No key, no cost.

## Codex review fixes (applied before merge)

Four P2 findings from the automated Codex review on PR #145 were valid and fixed in
`parseCompanyFacts` + the provider:
1. **debtToEquity now uses DEBT-specific concepts** (`LongTermDebtNoncurrent`/`LongTermDebt`
   + `LongTermDebtCurrent`/`DebtCurrent`/`ShortTermBorrowings`), not total `Liabilities`
   (which includes operating payables/leases and would over-state leverage for the
   bear-veto/quality score). Omitted when no debt concept is present (no liabilities fallback).
2. **Debt and equity are aligned on the same reporting period** (`valueAtEnd` reads debt at
   equity's latest `end`), instead of picking each concept's latest entry independently.
3. **EPS picks the latest reporting period across diluted+basic**, preferring diluted *within
   that period* and falling back to basic when diluted is stale/absent there (previously it
   chose the diluted array up-front and could return a stale diluted value).
4. **The SEC fetch pass is now budget-bounded** (`SEC_XBRL_BUDGET_MS` = 8 s, per-fetch timeout
   6 s): `enrich()` returns within budget with partial SEC data while the rate-limited loop
   keeps warming the cache in the background — a slow/timing-out SEC endpoint can no longer hang
   an interactive market scan. Test count rose to 57 (sec-xbrl + data-providers) with the new
   debt-concept/period-alignment/EPS-staleness cases.

## Codex review — round 2 (applied)

A second Codex pass on the round-1 fixes surfaced 5 more valid edge cases, all fixed:
1. **CIK-map load now inside the budget** — the weekly-cached ticker→CIK fetch (its own 9 s
   timeout + retry) ran BEFORE the 8 s race, so a cold map could still block ~18 s. It's now
   raced against the same deadline; on timeout the SEC pass is skipped (falls through), and the
   load keeps warming its cache in the background.
2. **`LongTermDebt` total no longer double-counts current maturities** — treated as a complete
   long-term total (current portion added only with the noncurrent-only concept).
3. **`ShortTermBorrowings` summed with current maturities** when there's no aggregate `DebtCurrent`
   (preferring the aggregate when present) — previously a `??` chain dropped it.
4. **Amended `10-K/A` restatements treated as annual** and the latest `filed` wins for a shared
   period end — the exact `10-K` filter previously published superseded values.
5. **Dual-class tickers preserved** — new `parseTickerCikMap`/`loadTickerCikMap` in `sec8k.ts`
   build a ticker→CIK map that keeps every ticker per CIK (e.g. GOOGL & GOOG), instead of reversing
   the collapsed CIK→ticker map (which dropped one class).

Tests now 63 in the SEC + data-providers suites. Full trio still green (tsc clean · 1132/1133 ·
build). Touched `src/lib/web-sources/sec8k.ts` additively (new exports; `loadCikMap` unchanged).

## Codex review — round 3 (applied): EPS dropped, debtToEquity only

A third Codex pass flagged that publishing `eps` from SEC at all was unsafe: `SymbolEnrichment.eps`
is documented as **TTM**, but an annual `10-K` EPS is a point-in-time fiscal-year figure. Because the
SEC provider sits *before* Yahoo in the cascade, a stale annual EPS could supersede Yahoo's TTM EPS
mid-year. Rather than synthesize a true trailing EPS from four quarterly facts (fragile, and outside
this connector's minimal-surface intent), **EPS was removed from the SEC provider entirely**:

1. **`parseCompanyFacts` now returns `{ debtToEquity?: number }`** — the whole EPS computation block
   (diluted/basic latest-period selection) was deleted. debtToEquity is a point-in-time balance-sheet
   ratio, so the annual-vs-TTM mismatch does not apply to it. EPS is left to Yahoo/FMP.
2. **`LongTermDebt` aggregate total now also adds `ShortTermBorrowings`** when present (the prior fix
   only added current maturities for the noncurrent-only concept), so revolver/commercial-paper debt
   isn't dropped from the leverage ratio.
3. **The per-symbol fetch loop's budget race uses `Math.max(0, deadline - Date.now())`** so a past
   deadline can't pass a negative delay to `setTimeout`.

Doc/comments/env all updated to say debtToEquity-only. Tests: the EPS describe block was replaced with
a "does NOT publish eps" guard, the 10-K/A amendment case was repurposed to a **debt** restatement
(amended `10-K/A` 900M wins over original `10-K` 600M for the same period end), and the "no debt
concept" case now asserts an empty result.

## Codex review — round 4 (applied)

The round-4 pass had only two findings still current against the merge commit (the other twelve were
`outdated` — already fixed in rounds 1–3); both valid and fixed:

1. **D/E now uses the latest balance-sheet PERIOD, not the latest annual filing.** `latestEntry` /
   `valueAtEnd` previously preferred 10-K/10-K/A, so after a company filed Q1/Q2/Q3 the provider would
   still publish last fiscal year-end's leverage (and, sitting ahead of Yahoo, override Yahoo's more
   current value). debtToEquity is a point-in-time balance-sheet ratio, so the latest reporting period —
   annual OR a newer 10-Q snapshot — is correct. Both helpers now pick the latest `end` across all forms
   (latest `filed` tie-break for amendments). When the latest equity period has no aligned debt fact, D/E
   is omitted (falls through to Yahoo) rather than reaching back to a stale aligned period. The dead
   `isAnnual` helper was removed. Test "prefers 10-K over non-10-K" was replaced with a "latest 10-Q
   supersedes prior 10-K" case plus an "omit when no aligned debt period" case.
2. **Concurrent background warms are de-duplicated.** The SEC pass keeps warming the cache past the
   per-scan budget; a second scan starting before the first finished could re-fetch the same companyfacts
   URLs. Added a module-level `secXbrlInFlight` Set (skip a symbol already being fetched) plus a
   pre-fetch cache re-check (use a just-warmed value instead of refetching).

Full trio green: tsc clean · 1146/1147 (only the cache-provenance flake) · build.

## Codex review — round 5 (applied)

Three findings current against the round-4 commit, all valid and fixed:

1. **Unit consistency — published D/E is capped at 10 (signal-inversion bug).** The provider computed a
   raw ratio (e.g. `12` for a 12×-levered firm), but display + qualityScore (`market.ts:834`,
   `dashboard-client.tsx:2097`) treat any `debtToEquity > 10` as a **percentage** and divide by 100 — so
   `12` rendered as `0.12` and an over-levered name scored as nearly debt-free. The bear-veto
   (`strategy.ts:834`) instead compares the raw value to a **ratio** ceiling with no `/100`, so a ratio is
   the correct convention; the only failure is real ratios >10 colliding with the display/quality
   heuristic. Capping the published ratio at 10 keeps all three consumers correct (vetoed · penalized ·
   shown "10.00"); 10×+ D/E is already pathological, so the cap only touches that extreme tail.
2. **Combined-lease + commercial-paper concepts** added to `debtAtEnd`: noncurrent falls back to
   `LongTermDebtAndFinanceLeaseObligationsNoncurrent`; the LT total to
   `LongTermDebtAndCapitalLeaseObligations`; current maturities to
   `LongTermDebtAndFinanceLeaseObligationsCurrent`; short-term to `CommercialPaper`. Filers using the
   combined tags no longer publish only a partial debt figure.
3. **LongTermDebt-total fallback when no current concept is tagged.** When `LongTermDebtNoncurrent` and a
   complete `LongTermDebt` total both exist for the period but no separate current-debt concept does,
   `debtAtEnd` now uses the larger total (it bundles the untagged current maturities) instead of the
   understated noncurrent-only figure.

Four new sec-xbrl tests (cap, combined noncurrent, commercial paper, total-fallback). Full trio green:
tsc clean · 1172/1173 (only the cache-provenance flake) · build.

## Codex review — round 6 (applied): honest cascade source attribution

One current finding: with SEC enabled but contributing nothing for a scan (budget timeout / no CIK / no
aligned period), `sec-xbrl` still appeared in `MarketScan.source` because the cascade's `name` is a
*static* join of every registered provider (`market.ts` used `provider.name` directly). This violated the
documented convention — source should list "every provider that **actually contributed** data this run."

It was **pre-existing and not SEC-specific** (every registered provider was named whether or not it
supplied a field); per the owner's direction it was fixed here as a cross-cutting change rather than
deferred:

- `CascadingEnrichmentProvider` now tracks a per-run `contributingNames` set (added whenever `takeScalar`
  **accepts** a field, when headlines are taken, on an analyst contribution, and on the AV sentiment
  override), reset at the start of each `enrich()`, and exposes `activeSources` — the registered providers
  that contributed ≥1 field, in registration order. Added to the `MarketEnrichmentProvider` interface as
  an optional accessor.
- `market.ts` builds `MarketScan.source` from `provider.activeSources` (falling back to the static name)
  so only contributing providers are named; when none contributed the enrichment segment is omitted.
- Class exported for tests; 4 new cases in `data-providers.test.ts` (only-contributors + order, first-wins
  loser excluded, analyst-only counts, reset-between-runs). This makes the implementation finally MATCH
  the long-documented `MarketScan.source` convention for ALL providers, not just SEC.

Full trio green: tsc clean · 1176/1177 (only the cache-provenance flake) · build.

## Round 7 (Codex review): keep the SEC cache warming after the budget elapses

Codex flagged (P2, line 2421) that the per-symbol callback inside the background `runRateLimited`
loop opened with `if (Date.now() > deadline) return;`. That guard contradicted the loop's own comment
("keeps running in the BACKGROUND to warm the cache"): once the 8 s interactive budget elapsed, every
remaining symbol returned **without fetching**, so the 24 h cache never warmed past the first slow miss.
Repeated scans then kept re-hitting that same leading miss instead of converging.

Fix: removed the per-symbol deadline short-circuit. The interactive budget is already enforced solely by
the outer `await Promise.race([work, timeout(deadline)])`, so the background continuation now runs to
completion — rate-limited (300 ms) and in-flight-deduped (`secXbrlInFlight`, so it never double-hits SEC)
— warming the full cache while interactive latency stays capped. Expanded the comment to state the budget
is enforced *only* by the outer race and the loop deliberately has no deadline check, so the guard isn't
re-added. No test asserted the old behavior; `test/sec-xbrl.test.ts` 22/22 still pass.

Full trio green: tsc clean · 1176/1177 (only the cache-provenance flake) · build.

## Round 8 (Codex review): use the complete LongTermDebt total when only short-term debt is separate

Codex flagged (P2, line 2328) a debt-aggregation gap in `debtAtEnd`. For the input shape:
`LongTermDebtNoncurrent` + a larger complete `LongTermDebt` total + separate `ShortTermBorrowings`/
`CommercialPaper`, but **no** `LongTermDebtCurrent`/`DebtCurrent` — the `current` var is set to
`shortTerm`, so the `current === undefined` gate on the "use the complete LongTermDebt total" fallback
was false and the code returned `noncurrent + shortTerm` instead of `ltdTotal + shortTerm`, dropping the
LT debt's current maturities that `ltdTotal` bundles. That understates D/E ahead of Yahoo and weakens the
quality score / over-leverage veto.

Root cause: the gate conflated the *LT current-maturity* component with *short-term borrowings*. The
decision to use `ltdTotal` (which already bundles LT current maturities) must depend ONLY on whether a
separate LT current-maturity concept (`LongTermDebtCurrent`/`DebtCurrent`) is tagged — `shortTerm`
(revolver/CP outside LT debt) is orthogonal and added on top either way. Fix: gate on
`hasSeparateLtCurrent = debtCurrentAgg !== undefined || ltdCurrent !== undefined` instead of
`current === undefined`. The only behavioral change is the reported shape; all prior debt-aggregation
cases are preserved. New regression test in `test/sec-xbrl.test.ts` (now 23 cases): noncurrent 500M +
complete total 600M + shortTerm 90M ÷ equity 345M → 2.0 (was the understated ~1.71).

Full trio green: tsc clean · 1177/1178 (only the cache-provenance flake) · build.

## Follow-ups

More standardized XBRL concepts (revenue, margins, cash-flow) could be threaded as NEW
enriched fields later — that would require the full add-a-field checklist
(`SymbolEnrichment` → `EnrichmentSourcedField` → `takeScalar`/`EMPTY_SOURCED` →
`MarketQuote`/`MarketQuoteSummary`/`EnrichmentSources` → `market.ts`), deliberately avoided
here to keep this connector minimal-surface and low-risk.
