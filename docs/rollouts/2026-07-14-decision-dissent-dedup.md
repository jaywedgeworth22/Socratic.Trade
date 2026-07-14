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

- Node 24 focused Vitest: 1 file / 4 tests passed.
- `npm run lint`: passed.
- `npx tsc --noEmit`: passed.
- `npm test`: 369 files / 4,132 tests passed.
- `npm run build`: passed, including TypeScript and 32 static pages. Existing middleware,
  documentation-token CSS scanning, webpack cache, and Sentry Edge warnings remain unrelated.
- `git diff --check`: passed.
- In-app Browser QA passed on desktop and 390 x 844 mobile: one canonical Red Team card, no
  duplicated objection/policy cards, no horizontal overflow, no console errors, and the
  `Promote lesson` interaction opened the coach-note field.

## Follow-ups

- Review and merge ready PR #1593, then verify the automatic production deployment. Production
  was not changed by this work.
