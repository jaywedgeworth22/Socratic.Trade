# OpenRouter Migration & Fallback Model Dropdown Fixes

## Summary
Migrated the strategy LLM model catalog to OpenRouter exclusively (adding GPT-5.6 Pro variants, Grok 4.5, and normalizing wire IDs). Fixed the strategy settings page where the fallback model selection dropdown was translucent (see-through) and checkbox clicks did not register due to a focus/blur event race condition. Added automatic filtering and database sanitization to grey out and disable selected primary models from the fallback lists.

## Why
1. **OpenRouter Exclusive Migration**: Ensures Socratic Trade routes all LLM calls through OpenRouter to maintain cost and rate limit controls. Model identifiers, rotations, and budget policies now support `openrouter/` prefixed paths consistently.
2. **Fallback Model Dropdown Visuals**: The dropdown list container and elements used `bg-[color:var(--con-surface-1)]`, but the actual theme variables defined in `app/console/console.css` only include `--con-surface`, `--con-surface-2`, and `--con-surface-3` (there is no `--con-surface-1`). As a result, the style fell back to transparent, making the dropdown menus translucent.
3. **Dropdown Interaction Defect**: Clicking a checkbox inside the absolute-positioned dropdown overlay caused the text input to lose focus (`blur`), which immediately closed the dropdown container (`setOpen(false)`) before the click event could propagate to toggle the checkbox. Preventing default `mousedown` events on the dropdown wrapper keeps the focus on the input while allowing clicks to register on the checkbox.
4. **Primary Model Separation**: Prevented selecting the active proposer/reviewer model as a fallback model, automatically filtering them out and greying/disabling them inside the picker.

## Files Modified
- [app/api/chat/providers/route.ts](file:///Users/jay/apps/trading-antigravity/app/api/chat/providers/route.ts)
- [app/console/assistant/chat.tsx](file:///Users/jay/apps/trading-antigravity/app/console/assistant/chat.tsx)
- [app/console/components/model-stats-drawer.tsx](file:///Users/jay/apps/trading-antigravity/app/console/components/model-stats-drawer.tsx)
- [app/console/settings/learning-review.tsx](file:///Users/jay/apps/trading-antigravity/app/console/settings/learning-review.tsx)
- [app/console/strategy/page.tsx](file:///Users/jay/apps/trading-antigravity/app/console/strategy/page.tsx)
- [app/ui/llm-model-catalog.ts](file:///Users/jay/apps/trading-antigravity/app/ui/llm-model-catalog.ts)
- [app/ui/model-picker.tsx](file:///Users/jay/apps/trading-antigravity/app/ui/model-picker.tsx)
- [src/lib/chat/llm.ts](file:///Users/jay/apps/trading-antigravity/src/lib/chat/llm.ts)
- [src/lib/llm-provider.ts](file:///Users/jay/apps/trading-antigravity/src/lib/llm-provider.ts)
- [src/lib/llm-request.ts](file:///Users/jay/apps/trading-antigravity/src/lib/llm-request.ts)
- [src/lib/llm-usage.ts](file:///Users/jay/apps/trading-antigravity/src/lib/llm-usage.ts)
- [src/lib/model-reasoning-recommendations.ts](file:///Users/jay/apps/trading-antigravity/src/lib/model-reasoning-recommendations.ts)
- [src/lib/model-rotation.ts](file:///Users/jay/apps/trading-antigravity/src/lib/model-rotation.ts)
- [src/lib/usage-budget.ts](file:///Users/jay/apps/trading-antigravity/src/lib/usage-budget.ts)

## Verification
All verification steps were executed under Node 24:
- `npm run lint` (passed with 0 errors)
- `npx tsc --noEmit` (passed with 0 errors)
- `npm test -- --run` (all 4,668 tests across 402 files passed successfully)
- `npm run build` (Next.js production build compiled cleanly with no type or path resolution errors)
