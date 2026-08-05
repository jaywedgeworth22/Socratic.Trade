# 2026-08-04 — Quote cascade freshness aligned with policy (stop ~15m delayed dead-end)

## Context & Objective

Production was soft-blocking / blocking nearly every opening proposal across Alpaca paper
and Tradier sandbox with `staleness_gate: SYM quote is ~900–1100s old (max 120s)`. That is
~15 minutes — exactly free delayed-quote latency, not random network lag.

Owner: it is insane to spend AI cycles on proposals that all die because quotes are always
15 minutes old when we have multiple real-time-capable sources.

## Root cause

1. **Market scan quote overlay** uses `fetchFreshQuotesCascade` (broker → Alpaca snapshot →
   Yahoo batch → Yahoo single → ROIC).
2. The cascade treated a quote as "fresh enough to stop" if `asOf` was within **16 minutes**.
3. **Tradier sandbox** (and free delayed Yahoo) stamp trade times ~**15 minutes** old.
4. Level 1 therefore accepted delayed quotes as fresh and **never tried** Alpaca snapshots or
   Yahoo real-time.
5. Policy `maxQuoteAgeSec` defaults to **120s** — so every delayed quote then failed the
   staleness gate (escalation → "pending" in Decide mode, or blocked when mixed with other
   reasons like Red Team notes).

Live receipt (prod market_scan): Tradier symbols with `ageSec: 901–904`, provider `tradier`,
scan source including `tradier-quotes+yahoo-finance-delayed-quotes`.

## Changes Made

- `src/lib/quotes-cascade.ts`
  - `cascadeFreshMaxAgeMs()` / `isQuoteFresh()` export: accept window = `policy.maxQuoteAgeSec`
    (default 120s from `DEFAULT_POLICY`), **not** 16 minutes.
  - Cascade stops only when `asOf` is within that window; ~15m delayed Level-1 quotes continue.
  - Fallback still returns the freshest available quote when nothing is within the bar
    (market closed / halt).
- `test/quotes-cascade.test.ts` — pins 15m delayed does not stop the cascade; 120s alignment.

## Decisions & Trade-offs

- After hours / weekends all trade times may still exceed 120s; then cascade returns best-
  effort and the non-blocking limit conversion / soft-escalation path still applies.
  That is correct — we cannot invent a live last trade.

## Verification State

```bash
npx vitest run --run test/quotes-cascade.test.ts test/staleness-gate.test.ts
# 21/21 passed
```

## Next Steps

- Land + auto-deploy; next strategy tick should show cascade continuing past delayed Tradier
  and attaching fresher Alpaca/Yahoo `asOf` when those sources answer.
- Optional follow-up: tag delayed providers explicitly and never stop on them even if asOf is
  within 120s by clock skew; not required if trade_date is honest ~15m lag.
