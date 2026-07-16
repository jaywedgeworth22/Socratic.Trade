# 2026-07-16 aiplatform.googleapis.com (Vertex AI) Agent Platform Auth Support + Codex autofix (2 rounds)

- **Summary**: Added URL-based detection of Vertex AI's `aiplatform.googleapis.com` Agent Platform OpenAI-compatible endpoints in `llmAuthHeaders`. Two rounds of Codex autofix.
- **Why**: Vertex Agent Platform OpenAI-compatible endpoints (`.../openapi/...` or `.../openai/...`) expect Bearer auth with an OAuth/ADC access token (https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/openai#authenticate). Native `:generateContent` endpoints are NOT supported via the chat-completions transport (separate body format needed — deferred).
- **Files**:
  - **Round 1**: `src/lib/llm-call.ts` (URL path detection: `/openapi/` or `/openai/` → Bearer, else `x-goog-api-key`), multiple call sites (passed `url` through to `llmAuthHeaders`), `docs/rollouts/2026-07-16-settings-subpages-redesign.md` (corrected false deletion claim).
  - **Round 2**: `src/lib/llm-call.ts` (removed `x-goog-api-key` for non-OpenAI-compatible Vertex URLs — native `:generateContent` endpoints need a separate transport), `test/llm-call.test.ts` (updated test name/expectation to reflect the limitation), `docs/rollouts/2026-07-15-ag-reconciled-improvements-landed.md` (marked PR #1616 follow-up as completed).
- **Verification**: Both rounds: tsc clean, 400 files / 4607 tests pass, build clean. All 4 Codex threads resolved, auto-merge enabled.
- **Follow-ups**: None.
