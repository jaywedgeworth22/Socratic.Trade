# Rollout Note: SEC RAG Search Fusion and Evaluation (P6-P7)

## Summary
Completed Days 1-7 of the SEC RAG ingestion, search fusion, and evaluation roadmap. Specifically:
1. Created an SQLite FTS5 table `document_chunks_fts` to support keyword-based search on document chunks.
2. Implemented hybrid search fusion (`src/lib/rag/search-fusion.ts`) combining FTS5 lexical results and vector cosine recall using Reciprocal Rank Fusion (RRF) and Maximal Marginal Relevance (MMR) cosine/Jaccard similarity diversity filtering.
3. Created a retrieval evaluation harness (`scripts/eval/rag-eval-harness.ts`) to query `sec_eval_golden_set` and report Recall@10, Recall@50, and nDCG metrics.

## Why
A standard vector search often misses exact string matches (like specific numbers or section headers) while lexical search misses semantic concepts. Fusing FTS5 matching with vector embeddings via RRF yields a superior candidate retrieval pool, and MMR ensures the final chunks are diverse (avoiding redudant blocks of text). The evaluation harness validates that new retrievers improve accuracy metrics on a standardized golden set.

## Files Touched
- [db.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/db.ts) (Added v49 migration for FTS5 virtual table)
- [persistence-hardening.test.ts](file:///Users/jay/apps/trading-ag-rag/test/persistence-hardening.test.ts) (Updated migration assertions)
- [db-learning.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/db-learning.ts) (Added `insertDocumentChunkFts` helper)
- [sec-ingest-worker.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/rag/sec-ingest-worker.ts) (Populated FTS5 on document chunking)
- [search-fusion.ts](file:///Users/jay/apps/trading-ag-rag/src/lib/rag/search-fusion.ts) [NEW] (FTS + Vector search fusion and MMR)
- [search-fusion.test.ts](file:///Users/jay/apps/trading-ag-rag/test/search-fusion.test.ts) [NEW] (Tests for fusion)
- [rag-eval-harness.ts](file:///Users/jay/apps/trading-ag-rag/scripts/eval/rag-eval-harness.ts) [NEW] (Golden set evaluator)
- [rag-eval-harness.test.ts](file:///Users/jay/apps/trading-ag-rag/test/rag-eval-harness.test.ts) [NEW] (Tests for evaluation harness)

## Verification
Ran TypeScript compilation, ESLint check, and unit test suites:
```bash
npx tsc --noEmit
npm run lint
npx vitest run test/sec-facts.test.ts test/sec-ingest-worker.test.ts test/search-fusion.test.ts test/rag-eval-harness.test.ts
npm run build
```
All checks passed successfully.
