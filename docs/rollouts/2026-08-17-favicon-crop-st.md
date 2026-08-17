# 2026-08-17 — Website favicon: cropped offset candlestick ST

## Context & Objective

Owner asked (issue #2731) for the website favicon to be the candlestick ST, cropped so the letters barely fit, on a transparent background, with S higher than T.  The tab icon had been synced to the iOS dollar-sign App Icon (`public/icon.png` === `AppIcon-1024.png`).  This restores the #1626 pipeline mark for the website only.

## Changes Made

The last committed `sampleWordmark("ST")` geometry (PR #1626, high-contrast colors from the 2026-08-01 pass) is checked in as `graphics/favicon-st-source.svg`.  A committed generator raises S by 60% of letter height, drops the full-bleed fill, and square-crops with a 2% inset so the offset mark barely fits.  Website PNG fallbacks are RGBA.  The iOS App Icon is not in the write list and was not modified.

- `graphics/favicon-st-source.svg`
- `scripts/generate-favicon-st.mjs`
- `scripts/generate-pwa-icons.mjs` (website PNG targets only; iOS App Icon path removed)
- `public/icon.svg`
- `public/icon.png`
- `public/icons/icon-192.png`
- `public/icons/icon-512.png`
- `public/icons/apple-touch-icon-180.png`
- `public/apple-touch-icon.png`
- `public/apple-touch-icon-precomposed.png`
- `app/layout.tsx`
- `app/manifest.ts`
- `test/favicon-st.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-13-candlestick-st-favicon.md`
- this note

## Decisions & Trade-offs

- Reused the #1626 pipeline dump instead of re-sampling letters in Node.  Font metrics differ across platforms; the checked-in SVG is the signed-off candle geometry.
- Offset is a vertical raise of S, not a new hand-drawn monogram.  #1626 already learned that a custom overlap/stagger sampler read as a candle cluster.
- Transparent canvas on every website raster, including apple-touch.  Safari home-screen compositing may sit the mark on a system fill; that is still the website icon, not the native App Icon.
- `scripts/generate-pwa-icons.mjs` no longer writes `AppIcon-1024.png`.  The 2026-08-04 generator had been a footgun for the dollar-sign iOS asset.

## Verification State

```bash
node scripts/generate-favicon-st.mjs
npx vitest run test/favicon-st.test.ts
# plus lint / tsc / full test / build before merge
md5sum ios/SocraticTrade/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png
# 46703def33604e89c127cfbaeafff1f0 — unchanged from origin/main
```

`public/icon.png` is 512×512 RGBA.  iOS App Icon hash matches `origin/main`.

## Next Steps & Blockers

Owner visual check of the tab icon on light and dark browser chrome after deploy.  No iOS / TestFlight follow-up; the App Icon was not touched.
