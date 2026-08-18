# 2026-08-18: Paper/live pooling truth + paper cost = OOS 20 bps

## Context & Objective

Owner cut 2026-08-17: paper→live pooling stays, but current-truth docs still advertised a
20-paper+5-live transfer gate that retrieval no longer applies. Paper execution-cost default was
1 bp while OOS walk-forward already haircuts 20 bps. Paper trains live, so 1 bp was dishonest.

## Changes Made

- Deleted the leftover 20-paper+5-live transfer-gate claim from current-truth docs. Pooling is
  unchanged: structured lessons still pool paper and live closed lots per user.
- Confirmed `src/lib/learning-transfer.ts` is already gone (removed 2026-07-23). No code gate
  still required 20 paper + 5 live lots.
- Raised the paper execution-cost default from 1 bp to 20 bps and dual-named it to the OOS
  constant (`OOS_ROUND_TRIP_COST_BPS` / `PAPER_DEFAULT_BASE_SLIPPAGE_BPS`). Did not touch
  `autoApplyWeights`.

Touched files:

- `src/lib/execution-cost.ts`
- `src/lib/backtest.ts`
- `src/lib/signal-health.ts`
- `src/lib/performance.ts`
- `test/execution-cost.test.ts`
- `test/performance.test.ts`
- `test/learning-loop-autotuning-db.test.ts`
- `docs/phase-7-strategy.md`
- `docs/reviews/2026-07-13-decision-evidence-architecture.md`
- `docs/rollouts/2026-07-13-evidence-architecture-gpt56.md`
- `PLAN.md`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-18-paper-live-pooling-cost.md`

## Decisions & Trade-offs

- Pooling stays. Research-scope `transferState` (`validated` / `rejected`) is not a paper-lot
  count gate and was left alone.
- Paper applies the shared 20 as a per-fill floor (entry and exit each pay it when the model
  runs). OOS applies the same 20 as a round-trip debit on a return series. The owner asked to
  unify or dual-name the constants; the number is now one export so they cannot drift. Env
  `PAPER_EXECUTION_COST_BASE_BPS` still overrides paper only.
- Did not enable or change `autoApplyWeights`.
- Did not steal #2792 / #2798 / #2800 / #2794. No Stripe.

## Verification State

Commands run after the first push (see later commits if the gate needed a fix):

```
npx tsc --noEmit
npx vitest run test/execution-cost.test.ts test/performance.test.ts test/learning-loop-autotuning-db.test.ts test/signal-health.test.ts test/learned-context-account-scope.test.ts test/lesson-vectors.test.ts
```

Full `npm run lint` / `npm test` / `npm run build` follow the first PR revision.

## Next Steps & Blockers

None for this cut. A later session can calibrate the 20 bps floor against realized live
slippage if the owner wants a fit, not a constant.

## Zero-Code Findings

The 20+5 transfer evaluator (`evaluatePaperToLiveTransfer`) was already deleted on 2026-07-23
with per-user pooling. The remaining lie was documentation plus the 1 bp paper floor.
