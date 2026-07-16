# 2026-07-16 aiplatform.googleapis.com (Vertex AI) Agent Platform Auth Support + Codex autofix (2 rounds)

- **Summary**: Added support for Vertex AI's `aiplatform.googleapis.com` OpenAI-compatible endpoint authentication via Google Cloud API Keys. Two rounds of Codex autofix.
- **Why**: Google Cloud API keys do not work in the standard `Authorization: Bearer` header for direct Vertex AI endpoints; they need `x-goog-api-key`. But Agent Platform OpenAI-compatible endpoints (`.../openapi/...`) expect Bearer auth.
- **Files**:
  - **Round 1**: `src/lib/llm-call.ts` (URL path detection: `/openapi/` or `/openai/` → Bearer, else `x-goog-api-key`), multiple call sites (passed `url` through to `llmAuthHeaders`), `docs/rollouts/2026-07-16-settings-subpages-redesign.md` (corrected false deletion claim).
  - **Round 2**: `src/lib/llm-call.ts` (removed `x-goog-api-key` for non-OpenAI-compatible Vertex URLs — native `:generateContent` endpoints need a separate transport), `test/llm-call.test.ts` (updated test name/expectation to reflect the limitation), `docs/rollouts/2026-07-15-ag-reconciled-improvements-landed.md` (marked PR #1616 follow-up as completed).
- **Verification**: Both rounds: tsc clean, 400 files / 4607 tests pass, build clean. All 4 Codex threads resolved, auto-merge enabled.
- **Follow-ups**: None.
