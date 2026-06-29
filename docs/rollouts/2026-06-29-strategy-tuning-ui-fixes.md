# 2026-06-29 - strategy-tuning-ui-fixes

## Summary

- Fixed a backend `TypeError: Cannot convert undefined or null to object` error caused when parsing tuning responses from models like `deepseek-reasoner` (R1) that don't enforce strict schemas.
- Removed all simulated OpenAI models (`gpt-5.4-nano`, `gpt-5.4-mini`, `gpt-5.4`, `gpt-5.5`) from the application. Modified all select lists to group real OpenAI models under a simple "OpenAI" label instead of "OpenAI (Real)".
- Changed all fallback models and default policy configurations from `gpt-5.4-mini` to `gpt-4o-mini`.
- Added model selection dropdown for Strategy Review (tuning) in both the Strategy Studio modal and Strategy View panel.
- Made the Strategy Prompt text box taller (`lg:h-[480px]`) on desktop views to fill empty screen real estate.
- Conditionally hid the "Reasoning Effort" policy configuration field when no reasoning-capable model (gpt-5 or o-series) is selected as Green Team, Red Team, or Strategy Review model.
- Researched other API provider options to see if other model families support reasoning-like settings.

## Why

- DeepSeek R1 returned incomplete JSON payload templates that omitted `scoringWeights` and/or `riskRules` when not strict-schema constrained. The backend failed to handle these null/undefined payloads safely.
- Simulated OpenAI models are no longer needed. The user wanted standard real models grouped directly under an "OpenAI" header.
- The default model was changed to `gpt-4o-mini` to use a real, cost-effective, and fully functional model as the baseline.
- Users wanted to select which model runs the Strategy Review on demand, rather than being forced to use the default Green Team model.
- The prompt textarea was too short on wide screens, leaving unnecessary blank space in the modal layout.
- "Reasoning Effort" is only supported/permitted on reasoning models (gpt-5 and o-series), so showing it for other model families (like Gemini, Grok, or Mistral) was confusing.

## Files

- `app/api/strategy/tune/route.ts`
- `src/lib/strategy-tuning.ts`
- `app/dashboard-client.tsx`
- `src/lib/llm-request.ts`
- `src/lib/defaults.ts`
- `STATUS.md`

## Verification

- `npx tsc --noEmit` passed clean.
- `npm run lint` passed with 0 errors (warnings-only backlog intact).
- `npm test` successfully completed all 1,498 unit tests.
- `npm run build` executed successfully without compilation issues.

## Research Findings: Model-Specific Reasoning Controls

1. **OpenAI (`gpt-5` / `o1` / `o3-mini`)**:
   - Supports `reasoning_effort` (with values `"low"`, `"medium"`, `"high"`), which the app now maps.
2. **Anthropic Claude (`claude-3-7-sonnet`)**:
   - Supports **Extended Thinking** settings: `thinking: { type: "enabled", budget_tokens: 1024 }` which regulates reasoning token limits.
3. **Google Gemini (Thinking models)**:
   - Supports a `thinking_budget` in its configuration to limit thinking tokens or turn thinking on/off.
4. **DeepSeek (R1)**:
   - Does not have a configurable parameter for reasoning effort in its official API (it generates thinking content automatically up to the max output tokens and has reasoning tokens separated by `<think>` blocks, but has no parameters to adjust "thinking effort").
5. **xAI (Grok) / Mistral**:
   - Currently do not support any specific reasoning/thinking parameters beyond classic parameters like `temperature`.
