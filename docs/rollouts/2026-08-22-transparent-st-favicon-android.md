# 2026-08-22 — Transparent ST favicon + future Android mark

## Context & Objective

Owner asked to update the website favicon to the supplied ST mark, keep that
same file as the future Android logo, and refresh the App Store Connect tile.
A follow-up said the transparent canvas is on purpose.  The conversation
attachment was not available as a file in this workspace, so the RGBA source
was rebuilt from the current iOS offset ST (read-only knockout) and then
treated as the source of truth.  Drop a replacement PNG on
`graphics/st-mark-transparent.png` and re-run the generator if the attached
mark was a different composition.

## Changes Made

`graphics/st-mark-transparent.png` is the RGBA source of truth.  The generator
resizes it with a transparent contain and never flattens onto white or black.
`--from-app-icon` can rebuild that source from the iOS offset ST (read-only).
The iOS `AppIcon-1024.png` file is not written.

- `graphics/st-mark-transparent.png`
- `graphics/android/ic_launcher_foreground.png`
- `graphics/android/README.md`
- `public/icon.png`
- `public/icons/icon-192.png`
- `public/icons/icon-512.png`
- `public/icons/apple-touch-icon-180.png`
- `public/apple-touch-icon.png`
- `public/apple-touch-icon-precomposed.png`
- `public/favicon.ico`
- `scripts/generate-favicon-st.mjs`
- `scripts/generate-pwa-icons.mjs`
- `app/layout.tsx`
- `test/favicon-st.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- this note

## Decisions & Trade-offs

- Transparency stays on web, `favicon.ico`, and the Android foreground.  Apple
  still requires an opaque 1024 for the store / home-screen icon, so the iOS
  App Icon is unchanged (offset ST on the light grid).
- App Store Connect has no separate iOS icon upload.  The stale white centered
  ST on the ASC site is the last uploaded build.  The next TestFlight that
  includes the current `AppIcon-1024.png` is what updates that listing tile.
- This cloud seat has no ASC `.p8` and no `xcodebuild`, so it cannot ship that
  build from here.

## Verification State

```bash
node scripts/generate-favicon-st.mjs --from-app-icon
node scripts/generate-favicon-st.mjs
npx vitest run test/favicon-st.test.ts
npx tsc --noEmit
md5sum ios/SocraticTrade/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png
# 46703def33604e89c127cfbaeafff1f0 — unchanged
```

`graphics/st-mark-transparent.png` is 1024x1024 RGBA with ~81% fully clear
pixels.

## Next Steps & Blockers

Owner visual check of the tab icon on light and dark chrome after deploy.
TestFlight only if the owner wants the App Store Connect tile to match the
current iOS App Icon.
