# Current Status

## 2026-07-11 — Whole-app audit + prioritized correctness fixes (CODEX, in progress)

Current `main@4c5a246b` is live and publicly healthy, but the audit found a P0 account-isolation
race in the console. The global account selector bypasses the existing unsaved-changes guard, while
Mandates and Framework keep account-specific drafts/autosave state mounted across a scope change.
Their `savePolicy` calls carry no target account; `/api/policy` resolves the active account only when
the request executes. A draft or in-flight save that originated on Account A can therefore be shown
or committed on Account B. The primary fix is implemented on `codex/app-wide-audit-20260711`:
dirty scope switches are intercepted, account-specific editors remount, mutations carry an
ownership-validated origin account, all same-tab policy writes serialize across cards, busy state
tracks the real queue, and prompt+policy persistence is validation-first/transactional. Node 24
focused verification is green: TypeScript plus 4 policy suites / 21 tests.

Three independent read-only lanes also verified and placed **33 additional non-duplicate issues** on
both effort boards: 7 P0, 18 P1, and 8 P2 across order/fill/risk accounting, inactive-account context,
mobile truth/accessibility, OAuth and middleware composition, webhook/SSRF/resource bounds, scheduler
hangs, onboarding rollback, and health/readiness truth. Including the active account-scope defect,
the audit tracks 34 findings (8 P0 / 18 P1 / 8 P2). Five are fully implemented on this branch:
account-scope isolation, synthetic-stop account routing, mobile initial-state truth, mobile command
preservation/readiness, and Robinhood OAuth exact-state/origin/session integrity. The core mobile
refresh race is also fixed with a deadline, coalesced trailing refresh, freshness gating, and focus/
visibility recovery; only health-aware fallback polling during an SSE outage remains for that row.
Adversarial review found and closed a native-beforeunload split-brain edge plus spoofable synthetic
routing fields. Combined Node24 focused verification is green: TypeScript, touched lint 0 errors /
6 inherited warnings, and 6 files / 85 tests. Production browser smoke covered Console, command
palette, and Orders with no console errors; public health reported exact live release `4c5a246b` and
green DB/scheduler/Litestream.

The full-gate test suite has now cleanly passed: `npm run lint` (0 errors / 402 warnings), `npx tsc --noEmit` (no errors), `npm test` (all 345 suites / 3836 tests passed), and `npm run build` completed successfully. The branch is now fully verified and ready for deployment. See
`docs/rollouts/2026-07-11-app-wide-audit-account-scope.md`.

## 2026-07-11 — Truthful notification delivery status (CODEX, current-main replacement branch)
## What was just completed
- Fixed `web-sources-sec.test.ts` dynamic dating issue which was causing the 30-day cutoff to fail once the static `2026-06-12` date aged out.
- Fixed `order-replacement.test.ts` to expect `pending_cancel` logic.
- Fixed TS2345 in `congress-analytics.ts` where `null` symbols could cause crashes.
- Verified completion of P1 items: Roth IRA truncation token cap raised to 4000+, `tradeThesisTag` coalescing in DB queries, and reflection dedupe signatures scoped per account.
- Implemented and verified LLM Failover UI and architecture.

## What's blocking / unresolved
- Nothing. All P1 and P2 items specified in the current sprint are complete.

## Next Action
- Land changes to main via `land.sh`.
