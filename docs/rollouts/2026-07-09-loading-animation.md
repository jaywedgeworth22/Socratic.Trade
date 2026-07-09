# Loading Animation

## Summary
Converted the static loading screen brandmark into an animated, fast-moving candlestick ticker with a subtle opacity pulse, providing explicit loading feedback for both desktop and mobile users.

## Why
Previously, when a user reloaded the page (or on mobile where the splash intro does not always play), the fallback `LoadingBrand` was fully static (or technically, moving at 1 tick per second). This felt unresponsive during the several seconds the snapshot took to load. By exposing the animation speed of `HeaderLogo` and adding a CSS pulse, it now functions as a proper loading indicator.

## Files
- `app/console/components/shell.tsx`
- `app/console/ui/header-logo.tsx`

## Verification
- Verified `HeaderLogo` accepts `speedMs` and speeds up correctly.
- Added `animate-pulse` to the `LoadingBrand` wrapper.
- Ran `npx tsc --noEmit` and `npm run build` using the land script.

## Follow-ups
None.
