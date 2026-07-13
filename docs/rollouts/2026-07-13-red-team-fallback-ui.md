# Red Team Fallback logic and UI Updates

## Summary
Implemented a robust failover capability for the Red Team model and improved the Settings UI for fallback models.

## Why
The Red Team model previously did not have fallback options, so it would fail if the primary model experienced transient errors. The user also wanted "fancier" text boxes for the model fallbacks to easily toggle options from the catalog without typing manually.

## Files
- `src/lib/types.ts`
- `app/api/policy/route.ts`
- `src/lib/red-team.ts`
- `app/console/strategy/page.tsx`

## Verification
- `npm run lint` (passed, fixed 1 error regarding `useRef` access during render)
- `npx tsc --noEmit` (passed)
- `npm test` (passed)
- `npm run build` (passed)

## Follow-ups
None.
