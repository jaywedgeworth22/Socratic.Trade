# 2026-06-30 - Strategy timeout and sizing guardrails

## Summary

Added guardrails for two production-visible issues:

- Green Team proposal requests using `gpt-5.5` with high reasoning can time out
  on the interactive strategy path.
- Opening proposals could sit on the hard per-order policy cap, such as a `$5`
  AAPL buy against a `$4.99` Roth IRA cap, and then fail at approval.

## Why

The diagnosed timeout run started at `2026-06-30T14:34:33.577Z` and failed at
`2026-06-30T14:35:47.124Z`, about 73.5s wall-clock. The LLM request itself hit
the existing 60s timeout. Extending the wait would hold the strategy lock longer
and allow more hidden reasoning-token spend on an interactive path, so the safer
default is to keep the timeout bounded and avoid the slowest model/effort combo.

The AAPL/Roth issue is a proposal-vs-policy headroom problem. The policy gate was
right to block the approval, but proposals should not be generated or staged
right at the maximum where rounding, price refresh, or broker review can tip the
order over the cap.

## Changes

- `gpt-5.5` + high reasoning is rejected by the policy route for interactive
  strategy settings.
- Stale stored `gpt-5.5` + high reasoning configs are runtime-clamped to medium
  effort for Green/Red strategy request bodies.
- The strategy prompt now sends both `limits.maxOrderNotional` and
  `limits.preferredMaxOrderNotional`; the preferred cap reserves 5% headroom.
- Deterministic opening sizing caps LLM-advised and fallback sizes to the
  preferred per-order policy cap without shrinking unrelated symbol/sector caps.
- The policy gate blocks opening orders that leave less than 5% headroom below
  the effective per-order cap, returning a concrete reduce-to amount.
- Assistant/chat draft promotion now returns `409 POLICY_BLOCKED` instead of
  inserting a pending proposal when the preview decision is already blocked.

## Files

- `src/lib/llm-request.ts`
- `src/lib/policy.ts`
- `src/lib/strategy.ts`
- `app/api/policy/route.ts`
- `app/api/proposals/from-draft/route.ts`
- `test/llm-request.test.ts`
- `test/policy.test.ts`
- `test/conviction-size-cap.test.ts`
- `test/policy-notification-events.test.ts`
- `test/chat-draft-policy.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-06-30-strategy-timeout-sizing-guardrails.md`

## Verification

- `npm ci` - installed this clean worktree's dependencies.
- `npx vitest run test/llm-request.test.ts test/policy.test.ts test/conviction-size-cap.test.ts test/policy-notification-events.test.ts test/chat-draft-policy.test.ts` - 68 tests pass.
- `npm run lint` - pass with 0 errors and 254 existing warnings.
- `npx tsc --noEmit` - pass.
- `npm test` - 166 files / 1582 tests pass.
- `npm run build` - pass.
- Note: after merging the latest `origin/main` production-build hotfix, the first
  webpack build retry failed with host `ENOSPC` while writing `.next/cache`.
  Deleted this worktree's generated `.next` only, reran `npm run build`, and it
  passed.

## Follow-ups

- Consider a per-context timeout knob only if a future queued/background strategy
  path needs deeper models; do not extend the interactive run timeout by default.
- Dollar-amount chat orders remain a separate pending feature. This change
  prevents blocked share-quantity drafts from being staged, but it does not add
  "buy `$X` of SYMBOL" parsing.
