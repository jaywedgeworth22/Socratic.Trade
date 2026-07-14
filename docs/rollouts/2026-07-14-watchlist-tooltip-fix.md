# Watchlist & Order Row Button Tooltip Alignment Fix

**Date:** 2026-07-14
**Branch:** `agent/ag-watchlist-tooltip-fix`
**PR:** https://github.com/jaywedgeworth22/Socratic.Trade/pull/1575

## Summary

Fixed edge cropping of action tooltips in the Watchlist and Order history rows by aligning them to the right. Also resolved a post-TypeScript 7 upgrade ESM/CommonJS path resolution error preventing Next.js production builds.

## Why

1. **Watchlist & Order Tooltip Clipping**: Tooltips on buttons on the far right edge of tables (like the action menus in Watchlist and Order History) default to center alignment. When opened, they extend past the screen's right edge, causing clipping or scroll overflows. Changing them to align to the right (`align="end"`) keeps them cleanly inside the viewport.
2. **TypeScript 7 postinstall build failure**: In PR #1531, TypeScript was upgraded to `7.0.2`. TypeScript 7 uses `"type": "module"`. The project has a postinstall script that redirects typescript imports inside `node_modules/typescript/lib/typescript.js` to CommonJS `typescript-v5`. Since Node parses `.js` files inside a ESM package as ESM, it threw `ReferenceError: module is not defined in ES module scope` in background Next.js build-worker processes that required `typescript.js`. Adding `package.json` with `{ "type": "commonjs" }` to the `node_modules/typescript/lib` folder instructs Node to parse `typescript.js` as CommonJS, which resolves the ESM runtime error.

## Files Touched

- `app/console/components/watchlist-table.tsx` — Aligned action tooltips to `align="end"`.
- `app/console/components/order-history-table.tsx` — Aligned action tooltips to `align="end"`.
- `package.json` — Updated `postinstall` script to write a CommonJS override `package.json` inside the typescript `lib/` directory.
- `package-lock.json` — Updated lockfile state.
- `STATUS.md` — Added entry.
- `docs/EFFORT-LOG.md` — Added Completed entry.

## Verification

```bash
npx tsc --noEmit    → clean (no errors outside test/ — pre-existing)
npm test             → 362 files / 4038 tests passed
npm run build        → compiled successfully, no errors (32/32 static pages generated)
```

## Follow-ups

- PR 1575 auto-merge has been enabled and will merge to `main` as soon as status checks complete.
