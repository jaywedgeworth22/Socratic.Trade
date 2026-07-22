# RAG rerank policy and retrieval-stage telemetry foundation

## Summary

Added two pure, production-inert foundations for the RAG strategic-performance program:

- independent rerank provider/model resolution with truthful missing-credential behavior;
- default-off adaptive candidate-depth planning for scout, deep, exact, and general queries;
- text-free per-stage retrieval receipts carrying duration, route, model/provider, namespace,
  cache, candidate, and drop counts.

The central retrieval path is intentionally unchanged. A later integration PR will wire these
modules only after the managed-ingestion regression, production-path PIT evaluator, and corpus-wide
lexical candidate module are reviewed.

## Why

Embedding and reranking currently share one provider selector, which prevents clean model
experiments. Retrieval also lacks a complete per-stage trace, so fixed latency/cost claims cannot be
validated and scout fan-out cannot be tuned independently from deep dossiers. These pure modules
create explicit contracts without changing production ranking behavior prematurely.

## Files

- `src/lib/rag/rerank-policy.ts`
- `src/lib/rag/retrieval-stage-telemetry.ts`
- `src/lib/rag/env-flag.ts`
- `test/rag-env-flag.test.ts`
- `test/rag-rerank-policy.test.ts`
- `test/rag-retrieval-stage-telemetry.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/chat-assistant-rag-learning.md`
- `docs/rollouts/2026-07-21-rag-rerank-policy-telemetry.md`

## Verification

Executed:

```bash
npx vitest run test/rag-env-flag.test.ts test/rag-rerank-policy.test.ts test/rag-retrieval-stage-telemetry.test.ts
npx eslint src/lib/rag/env-flag.ts src/lib/rag/rerank-policy.ts src/lib/rag/retrieval-stage-telemetry.ts test/rag-env-flag.test.ts test/rag-rerank-policy.test.ts test/rag-retrieval-stage-telemetry.test.ts
npx tsc --noEmit
```

Results: 3 files / 28 tests passed; scoped ESLint returned zero errors; TypeScript returned zero
errors.

## Follow-ups

- Wire route resolution and stage receipts through `retrieveContextDetailed` only after the P0
  managed-ingestion fix lands.
- Union current-schema FTS5 candidates with dense candidates before exactly one rerank.
- Keep `RAG_ADAPTIVE_RERANK` default off until the production-path evaluator establishes quality,
  latency, and cost thresholds.
- Do not start a corpus re-embed or purge from this lane; that production operation has a separate
  active owner and requires independent count/receipt verification.
