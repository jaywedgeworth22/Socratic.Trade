# Dense plus lexical RAG retrieval integration

## Summary

Integrated the reviewed RAG foundations into the production retrieval path behind default-off
flags. Retrieval can now union independently recalled SQLite FTS5 filing occurrences with dense
Pinecone matches through one RRF pass, then invoke at most one explicitly routed reranker. Adaptive
candidate depth and text-free stage traces are wired without changing defaults.

## Why

The previous `HYBRID_RETRIEVAL` pass computed BM25 only over candidates Pinecone had already
returned, so it could reorder recall but could not recover a missed exact accession, covenant, or
filing term. Embedding and rerank routing were also coupled, and stage latency/drop behavior was not
available as a single safe receipt.

## Files

- `src/lib/vector-db.ts`
- `src/lib/rag/recall-fusion.ts`
- `src/lib/rag/corpus-wide-lexical.ts`
- `src/lib/rag/retrieval-stage-telemetry.ts`
- `test/rag-recall-fusion.test.ts`
- `test/corpus-wide-lexical.test.ts`
- `test/vector-db-retrieval.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/chat-assistant-rag-learning.md`
- `docs/rollouts/2026-07-22-rag-retrieval-integration.md`

## Decisions and safeguards

- `RAG_CORPUS_WIDE_LEXICAL` remains off until the production evaluator meets quality/latency gates.
- FTS query grammar is quoted and bounded; managed occurrences must have committed receipts and be
  the current document head, or the version active at the requested point in time.
- Lexical BM25 is never fabricated as cosine, and a dense cosine floor cannot erase an independently
  recalled lexical candidate.
- Dense/lexical overlaps retain the dense score and receive dual retrieval provenance.
- `RAG_RERANK_PROVIDER` may differ from `RAG_EMBED_PROVIDER`; a missing explicit rerank credential
  never falls back to another provider and never creates a fake relevance score.
- `RAG_ADAPTIVE_RERANK` and `RAG_RETRIEVAL_STAGE_TELEMETRY` remain default-off.
- No provider, corpus, re-embed, purge, secret, or production mutation occurred.

## Verification

Executed before current-main reconciliation:

```bash
npx vitest run test/rag-recall-fusion.test.ts test/rag-rerank-policy.test.ts test/rag-retrieval-stage-telemetry.test.ts test/vector-db-retrieval.test.ts test/corpus-wide-lexical.test.ts
npx eslint src/lib/vector-db.ts src/lib/rag/recall-fusion.ts src/lib/rag/corpus-wide-lexical.ts src/lib/rag/retrieval-stage-telemetry.ts test/rag-recall-fusion.test.ts test/corpus-wide-lexical.test.ts test/vector-db-retrieval.test.ts
npx tsc --noEmit
```

Results: 5 files / 45 tests passed; scoped ESLint reported zero errors (77 inherited warnings).
TypeScript reached the old branch baseline failure in `test/vector-db-chunk-cap.test.ts` assigning
read-only `NODE_ENV`; upstream PR #1857 has since merged the fixture/CI repair, so the authoritative
TypeScript and full ordered gate will be rerun after merging current `origin/main`.

## Follow-ups

- Reconcile current `main`, integrate the production evaluator, prompt-consumption receipts,
  structured-data routing, bounded parent expansion, and read-only provider shadow benchmarks.
- Run the required lint, TypeScript, full Vitest, and production build gate before landing.
- Keep production flags unchanged until real-corpus PIT evaluation establishes promotion thresholds.
