# 2026-07-16 aiplatform.googleapis.com (Vertex AI) Agent Platform Auth Support + Codex autofix

- **Summary**: Added support for Vertex AI's `aiplatform.googleapis.com` OpenAI-compatible endpoint authentication via Google Cloud API Keys. Then fixed by Codex autofix to distinguish between direct Vertex AI endpoints (x-goog-api-key) and Agent Platform OpenAI-compatible endpoints (Bearer auth).
- **Why**: Google Cloud API keys do not work in the standard `Authorization: Bearer` header for direct Vertex AI endpoints; they need `x-goog-api-key`. But Agent Platform OpenAI-compatible endpoints (`.../openapi/...`) expect Bearer auth.
- **Files**:
  - `src/lib/llm-call.ts` (added URL path detection: `/openapi/` or `/openai/` → Bearer, else `x-goog-api-key`)
  - `src/lib/strategy.ts`, `src/lib/learning-review.ts`, `src/lib/framework-review.ts`, `src/lib/post-mortem.ts`, `src/lib/proposal-revalidation.ts`, `src/lib/red-team.ts`, `src/lib/strategy-tuning.ts`, `src/lib/outcome-engine.ts`, `src/lib/rag/multi-query.ts`, `test/llm-call.test.ts` (passed `url` through to `llmAuthHeaders`)
- **Verification**: Codex autofix: tsc clean, 400 files / 4607 tests pass, build clean. Both Codex threads resolved, auto-merge enabled.
- **Follow-ups**: None.
