# Congress Score Eval UI Wiring

- **Summary:** Added the UI to surface the `congressScoreVerdict` in the Market Scan tab of the console dashboard. This completes the "Wire congress-score-eval go/no-go into scan/scoring" feature which was previously lacking the UI representation.
- **Why:** The backend statistical validation for the congressional trading signal (go/no-go) was implemented and actively gating the composite (when enabled), but the verdict and gating status were invisible to the user in the UI. We now explicitly display the validation status, t-stat, and whether the signal is currently gated.
- **Files:**
  - `app/dashboard-types.ts`
  - `app/console/scan/page.tsx`
- **Verification:** Ran `npm run lint`, `npx tsc --noEmit`, `npm test`, and `npm run build`. All passed successfully.
- **Follow-ups:** None.
