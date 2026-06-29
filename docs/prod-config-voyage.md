# Voyage + Pinecone: production tuning & gated upgrades

The RAG/memory stack uses **Voyage** for embeddings + reranking and **Pinecone** for the vector
store. Out of the box it runs at high quality with the current key; two upgrades are **gated** behind
an owner decision because they cost money and/or require a reindex.

## What's on by default (no action needed)
- **Embeddings:** `voyage-finance-2` (1024-dim) — a finance-domain model, correct `input_type`
  (document vs query).
- **Reranking:** ON (`VECTOR_ENABLE_RERANK=on`, `VOYAGE_RERANK_MODEL=rerank-2.5`). Pinecone
  over-fetches by cosine recall, then Voyage's cross-encoder reorders by true relevance. Fails safe
  to cosine order on any error. This is the single biggest retrieval-quality lever.
- **Point-in-time guard:** 8-K vectors now carry `acceptance_datetime`, so `retrieveContextDetailed({asOf})`
  excludes look-ahead filings (no backtest leakage).
- **Query filters available:** `docType` / `section` / `source` metadata filters + `minScore` floor
  on `retrieveContextDetailed`.

## Gated upgrade 1 — paid Voyage tier (faster ingestion)
The free tier is **3 requests/minute**, so `VECTOR_EMBED_BATCH_DELAY_MS` defaults to 21000 (one batch
every 21s). On a paid key:
```
VECTOR_EMBED_BATCH_DELAY_MS=0
VECTOR_EMBED_BATCH_SIZE=128
```
This makes full-filing (10-K/10-Q) ingestion run in seconds instead of minutes. Set a Voyage budget
alert. No code change, no reindex.

## Gated upgrade 2 — larger embedding model (full reindex, breaking)
Moving to a larger model (e.g. `voyage-3-large`, 1536-dim) is a **breaking dimension change** that
requires re-embedding every stored document into a new Pinecone index. Plan it as a migration:
1. Create a new 1536-dim index (don't mutate the live one).
2. Re-embed from the source-of-truth tables (8-K dataset, filings) into the new index.
3. Cut `VOYAGE_MODEL`/`EMBEDDING_DIMENSION`/index name over once parity is verified.
Expect a degraded/empty-retrieval window during the migration; version-tag vectors so old/new can
coexist during cutover. Do NOT flip the model constant without doing this.

## Follow-ups (additive)
- ~~Voyage/Pinecone usage metering~~ — **shipped 2026-06-29** (`src/lib/rag-metering.ts`, `rag_usage` table, wired into `vector-db.ts`)
- ~~Chunk-level `content_hash` dedup~~ — **shipped 2026-06-29** (`document_chunks` table, `filterNewDocumentChunks` in `storeDocument`, `hashContent` in `chunkDocument`)
- Full 8-K body ingest — **shipped 2026-06-29** (gated behind `WEB_SOURCE_SEC8K_FULL_BODY`, default OFF; `ingestEightKBody` in `sec8k.ts`)
- Wire `docType`/`minScore` into specific callers (e.g. a fundamentals-only retrieval).
