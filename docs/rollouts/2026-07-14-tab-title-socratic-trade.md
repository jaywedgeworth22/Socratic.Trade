# 2026-07-14: Update Browser Tab Title to "Socratic Trade"

- **Summary**: Removed the "Autonomy Desk" override in `app/console/layout.tsx` so the browser tab strictly reads "Socratic Trade" across the main console.
- **Why**: The user requested that the `<title>` shown in the browser tab be "just Socratic Trade instead of Automation Dashboard (Socratic Trade)".
- **Files**:
  - `app/console/layout.tsx`
- **Verification** ([codex-autofix] verification round, 2026-07-15):
  - `npm run lint` — 0 errors, 459 warnings (grandfathered backlog)
  - `npx tsc --noEmit` — clean
  - `npm test` — 4172 passed (370 files)
  - `npm run build` — clean
- **[codex-autofix]** Also removed `title: "Coach"` from `app/console/assistant/page.tsx` so the browser tab reads "Socratic Trade" consistently across ALL console subroutes.
- **Follow-ups**:
  - Merge the branch containing this change.
