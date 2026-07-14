# Decision-detail dissent deduplication

## Summary

The decision trace previously showed the same Red Team reason in the structured verdict card,
the generic dissent list, and a generated policy wrapper. The renderer now treats the structured
verdict as canonical and removes only exact or recognized generated echoes. Distinct policy
objections and override context remain visible. Persisted decision data is unchanged.

## Files changed

- `app/console/decisions/[id]/page.tsx` uses the display-filtered dissent list.
- `app/console/lib/dissent.ts` contains the pure exact/generated-echo filter.
- `test/console-dissent-dedup.test.ts` covers canonical echoes, generated wrappers, override
  context, distinct policy objections, and legacy cases without a structured verdict.
- `STATUS.md`, `PLAN.md`, `docs/phase-8-cockpit-ui.md`, and `docs/EFFORT-LOG.md` record the change.

## Verification

- Node 24 focused Vitest: 1 file / 5 tests passed.
- `npm run lint`: passed.
- `npx tsc --noEmit`: passed.
- Pre-review `npm test`: 369 files / 4,132 tests passed locally and in `scripts/land.sh`.
- `npm run build`: passed, including TypeScript and 32 static pages. Existing middleware,
  documentation-token CSS scanning, webpack cache, and Sentry Edge warnings remain unrelated.
- `git diff --check`: passed.
- In-app Browser QA passed on desktop and 390 x 844 mobile: one canonical Red Team card, no
  duplicated objection/policy cards, no horizontal overflow, no console errors, and the
  `Promote lesson` interaction opened the coach-note field.

## Follow-ups

- Review and merge ready PR #1593, then verify the automatic production deployment. Production
  was not changed by this work.

## Round 1 autofix — preserve overridden Red Team dissent rows (P2, Codex review)

**What changed:** `dissentItemsForDisplay` previously seeded its `seen` set with the canonical
Red Team verdict reason, then dropped ALL dissent items whose summary matched — including
`red_team` items whose title said "overridden" but whose summary was the bare reason text. The
override context was lost from the trace.

**Fix:** Skip the exact-summary dedup check for `red_team` items whose title contains
"overridden" — they carry meaningful context the canonical verdict card doesn't show.

**Test gap closed:** The original test used a modified summary with the override annotation
appended to the reason text. The real `syncSocraticDecisionLifecycle` keeps `redTeamVerdict.reason`
as the summary verbatim, so the original test didn't actually catch the bug. Added a test case
that matches production behavior (bare reason as summary).

Post-fix focused Vitest (5/5), scoped ESLint, standalone TypeScript, and diff-check passed. Required
hosted CI, Playwright smoke, and gitleaks passed on the pre-autofix head; final-head reruns remain.
Auto-merge is disabled and production is unchanged.
