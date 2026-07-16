# Fallback Model see-through and selection fix

## Summary
Fixed the strategy settings page where the fallback model selection dropdown was translucent (see-through) and checkbox clicks were not registered due to a focus/blur event race condition. Also fixed a similar translucent background issue in the Guardrails StopFlow diagram.

## Why
1. The dropdown list container and elements used `bg-[color:var(--con-surface-1)]`, but the actual theme variables defined in `app/console/console.css` only include `--con-surface`, `--con-surface-2`, and `--con-surface-3` (there is no `--con-surface-1`). As a result, the style fell back to transparent, making the dropdown menus translucent.
2. Clicking a checkbox inside the absolute-positioned dropdown overlay caused the text input to lose focus (`blur`), which immediately closed the dropdown container (`setOpen(false)`) before the click event could propagate to toggle the checkbox. Preventing default `mousedown` events on the dropdown wrapper keeps the focus on the input while allowing clicks to register on the checkbox.
3. The Guardrails `StopFlowDiagram` component similarly utilized `--con-surface-1`, causing it to have a translucent background.

## Files
- [page.tsx](file:///Users/jay/apps/trading-antigravity/app/console/strategy/page.tsx)
- [stop-flow.tsx](file:///Users/jay/apps/trading-antigravity/app/console/guardrails/stop-flow.tsx)

## Verification
- `npm run lint` (passed with 0 errors)
- `npx tsc --noEmit` (passed)
- `npm test -- --run` under Node 24 (passed, all 4,668 tests green)
- `npm run build` (passed, Next.js build completed successfully)
