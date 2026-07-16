# 2026-07-16 aiplatform.googleapis.com (Vertex AI) Agent Platform Auth Support

- **Summary**: Added support for Vertex AI's `aiplatform.googleapis.com` OpenAI-compatible endpoint authentication via Google Cloud API Keys.
- **Why**: The user reported that Google Cloud API keys do not work in the standard `Authorization: Bearer` header for Vertex AI (`aiplatform.googleapis.com`). They need to be passed in the `x-goog-api-key` header to authenticate properly when routed through the Agent Platform API.
- **Files**:
  - `src/lib/llm-call.ts` (added URL checking for Vertex AI and passing `x-goog-api-key`)
  - `src/lib/strategy.ts`, `src/lib/learning-review.ts`, `src/lib/framework-review.ts`, `src/lib/post-mortem.ts`, `src/lib/proposal-revalidation.ts`, `src/lib/red-team.ts`, `src/lib/strategy-tuning.ts`, `src/lib/outcome-engine.ts`, `src/lib/rag/multi-query.ts`, `test/llm-call.test.ts` (passed `url` through to `llmAuthHeaders`)
- **Verification**: `npx tsc --noEmit` and tests passed locally.
- **Follow-ups**: None.
