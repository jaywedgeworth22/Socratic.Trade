# 2026-07-14: Update Browser Tab Title to "Socratic Trade"

- **Summary**: Removed the "Autonomy Desk" override in `app/console/layout.tsx` so the browser tab strictly reads "Socratic Trade" across the main console.
- **Why**: The user requested that the `<title>` shown in the browser tab be "just Socratic Trade instead of Automation Dashboard (Socratic Trade)".
- **Files**:
  - `app/console/layout.tsx`
- **Verification**:
  - `npm run lint`
  - `npx tsc --noEmit`
  - `npm test`
  - `npm run build`
- **Follow-ups**:
  - Merge the branch containing this change.
