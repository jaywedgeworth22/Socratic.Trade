# 2026-07-09 — Alpha Vantage + Twelve Data made to fit their free tiers (MONET)

Owner: "can we do something about how we call those [Alpha Vantage + Twelve Data]
so that they work? didn't we discuss adding multiple alpha vantage keys while
restricting calls per minute to avoid IP block?"

## Diagnosis (prod, 2026-07-09)

Both are free-tier data providers whose quotas are simply too small for hourly
multi-account scans — and neither failure was a call-technique bug except Twelve
Data's batching. The scan itself is healthy (Massive/FMP/Finnhub/Yahoo/Alpaca
snapshot all 100% — Yahoo recovered after the earlier pacing fix); AV and TD are
supplementary.

- **Alpha Vantage**: the multi-key pool built in #1167 IS deployed and working —
  its own log says *"entire key pool exhausted for today (1/1 keys hit the 25/day
  cap)."* It's running on the single `ALPHAVANTAGE_API_KEY`. Nothing to fix in
  code; it needs **more keys** (config).
- **Twelve Data**: 100% HTTP 429. Root cause is a real batching bug — the /quote
  endpoint charges **1 credit per symbol** and the free Basic tier is **~8
  credits/minute**, but the code sent up to **120 symbols in one call** = 120
  credits at once → instant 429 on every call. The 10s serial limiter couldn't
  help because a single call was already 15× over the per-minute budget.

## Changes (this PR — Twelve Data code; Alpha Vantage is config only)

`src/lib/data-providers.ts` (`TwelveDataEnrichmentProvider.enrich`):
- **Credit-budget cap**: a call now carries at most `twelveDataCreditsPerMin()`
  symbols (env `TWELVEDATA_CREDITS_PER_MIN`, default 8 = the free per-minute
  credit budget). The highest-priority misses (the scan passes candidates
  best-first) are queried; the rest are best-effort `{}` this run and picked up
  by other providers / the cache / a later scan. A health receipt records how
  many were deferred (no silent truncation).
- **One-call-per-window gate (skip, don't queue)**: a process-wide 60s window
  (`TWELVEDATA_WINDOW_MS`) allows one credit-budget call per window; any other
  scan landing inside it returns best-effort immediately. This is deliberately a
  SKIP, not a queue — enrichment providers run in parallel in the cascade with no
  per-provider timeout, so a 60s queue wait would stall the 2nd–5th account's
  whole scan at the top of the hour. The read+set is synchronous (no await
  between), so concurrent same-tick scans can't both pass.

`src/lib/provider-rate-limit.ts`: the twelvedata pacer is now a light
serialization backstop (concurrency 1, 2s) rather than the primary control —
NOT 60s, which would re-introduce the scan stall the window gate avoids.

Tests (`test/data-providers.test.ts`, `test/provider-rate-limit.test.ts`):
call caps to ≤ budget symbols with every input still represented; a second
same-window scan skips the network entirely (no queue/stall); the pacer default.

## Alpha Vantage — DONE (config): 6 keys wired into Infisical

The pool reads `ALPHAVANTAGE_API_KEYS` (comma-separated), falling back to the
single `ALPHAVANTAGE_API_KEY`. **2026-07-09: the owner provided 6 keys via a
`chmod 600` secret-handoff file (`~/.secrets/alphavantage-keys`, `LABEL=KEY`
per line); MONET set `ALPHAVANTAGE_API_KEYS` (6 keys) in Infisical prod — values
never printed; verified 6 keys present on readback.** That's 150/day with the
pool rotating sticky-until-daily-cap and global ≥1.1s pacing keeping calls per
minute restricted so no single IP bursts — exactly the "multiple keys +
per-minute restriction to avoid IP block" plan. **Activates on the next
prod restart/deploy** (env injected at container start) — bundled with the
Twelve Data deploy below. Honest caveat: even 150/day is modest; AV/TD are
supplementary, and the long-term options remain pay-for-tier or drop-from-cascade
if their specific fields aren't wanted.

## Verification

`npm run lint` / `npx tsc --noEmit` / `npm test` / `npm run build` — recorded in
the PR. Diagnosis done read-only against the prod DB snapshot (api_health_log);
no box state changed.

## Follow-ups

- Wire the owner's Alpha Vantage keys into `ALPHAVANTAGE_API_KEYS` (Infisical) +
  redeploy/restart to pick them up.
- Optional: extend the same window-gate/credit-cap pattern to a multi-key Twelve
  Data pool if a second free key is added (each key = +8 credits/min).
- Optional: budget-aware symbol prioritization (positions + top candidates first)
  is already approximated by "best-first misses"; could be made explicit.
