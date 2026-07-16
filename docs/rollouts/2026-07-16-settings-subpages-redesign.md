# Settings Sub-pages Redesign

- **Summary:** Redesigned the remaining settings sub-pages (`help.tsx`, `sharing.tsx`, `danger.tsx`, `learning-review.tsx`) to use the new `Card` layout, completing the transition away from the legacy iOS-style components.
- **Why:** The user explicitly requested removing nested boxes and standardizing the UI with the shared `Card` layout across all console pages.
- **Files:**
  - `app/console/settings/help.tsx`
  - `app/console/settings/sharing.tsx`
  - `app/console/settings/danger.tsx`
  - `app/console/settings/learning-review.tsx`
  - `app/console/guardrails/page.tsx` (fixed a minor import syntax error)
  - `app/ui/ios-components.tsx` (not deleted — still imported by settings pages; deletion deferred)
- **Verification:**
  - Replaced components successfully.
  - Ran `npm run build`, fixed a syntax error, then `npm run build` succeeded.
- **Follow-ups:** None.
