# 2026-07-06: Red Team explicitly chosen model override fix

## Summary
Fixed an issue where `debateProposal` (the Red Team step) was completely ignoring the user's explicitly chosen `redTeamLlmModel` (e.g. `deepseek-v4-pro`) if the global environment variable `RED_TEAM_LLM_PROVIDER` was set to `anthropic` and the user had an Anthropic API key configured. 

## Why
A user reported that choosing `deepseek-v4-pro` for the Red Team was "not working" on their Roth IRA account. Log investigation revealed that the system was forcibly hijacking the debate and sending it to Anthropic (as a cross-provider Bear), which failed because the user's Anthropic API key was quota-limited. The logic was flawed because it didn't check whether the user explicitly chose a Red Team model; it just forcefully applied the Anthropic override as long as an Anthropic key existed. The logic has been corrected to only apply the cross-provider Bear override when no explicit Red Team model is chosen in the policy.

## Files Touched
- `src/lib/red-team.ts`

## Verification
- Local build and test suite passed.
- `npm run lint` — passed.
- `npx tsc --noEmit` — passed.
- `npm test` — passed.
- `npm run build` — passed.

## Follow-ups
None immediately. This unblocks users who wish to use non-Anthropic models (like DeepSeek V4 Pro) for the Red Team debate even if the server is configured to encourage Anthropic usage.
