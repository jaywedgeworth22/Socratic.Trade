# 2026-06-26 — Codex Autofix verify fixes (PR #202)

## Summary
Autonomous Codex-Autofix fixer responded to the two inline P2 findings Codex left
on PR #202's verification fixture (`src/lib/codex-autofix-verify-fixture.ts`).

## Why
PR #202 ("test: Codex Autofix end-to-end verification") intentionally seeds two
correctness bugs in a throwaway fixture to confirm the autofix loop addresses
Codex review threads end-to-end. Codex flagged both; this commit fixes them.

## Findings addressed
1. **`percentChange` wrong denominator** (line 9). `((current - previous) / current)`
   returned 33.33 for `percentChange(100, 150)` where the documented example says
   50. Fixed to divide by `previous`.
2. **`average` off-by-one** (line 17). Loop ran `i <= values.length`, so the final
   iteration read `values[length]` (`undefined`) and produced `NaN`. Fixed to
   `i < values.length`.

Both are unambiguous correctness bugs, so they were fixed directly rather than
referred to the maintainer.

## Files
- `src/lib/codex-autofix-verify-fixture.ts` — both fixes.
- `STATUS.md` — new dated entry.
- `docs/rollouts/2026-06-26-codex-autofix-verify-fixes.md` — this note.

## Verification
- `npm install` (deps weren't present in this environment) — package-lock restored
  to branch HEAD afterward (no dependency change intended).
- `npx tsc --noEmit` — clean.
- `npm test` — 1428 passed (148 files).
- `npm run build` — green; `next-env.d.ts` / `tsconfig.json` restored from
  origin/main afterward.

## Follow-ups
- The fixture is not imported anywhere and is safe to delete once the autofix loop
  is confirmed working end-to-end. PR title says DO NOT MERGE — left to maintainer.
