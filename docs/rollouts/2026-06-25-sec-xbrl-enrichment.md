# 2026-06-25 — SEC EDGAR XBRL company-facts enrichment provider (keyless, default-OFF)

Branch: `claude/sec-xbrl-enrichment` (off `origin/main`). Final clean/additive backlog
item. Implemented by a Sonnet subagent against a tight spec; reviewed + verified by the
Opus main agent (full tsc/test/build trio + code read of the parse + cascade wiring).

## Summary

A keyless, default-OFF enrichment provider that fills the EXISTING `SymbolEnrichment`
fields `debtToEquity` and `eps` from authoritative SEC filings via the public
companyfacts API (`https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`).

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

## Follow-ups

More standardized XBRL concepts (revenue, margins, cash-flow) could be threaded as NEW
enriched fields later — that would require the full add-a-field checklist
(`SymbolEnrichment` → `EnrichmentSourcedField` → `takeScalar`/`EMPTY_SOURCED` →
`MarketQuote`/`MarketQuoteSummary`/`EnrichmentSources` → `market.ts`), deliberately avoided
here to keep this connector minimal-surface and low-risk.
