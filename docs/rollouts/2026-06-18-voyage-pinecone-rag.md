# 2026-06-18: Voyage AI & Pinecone RAG Integration

## Summary
Replaced the stubbed RAG layer with a production-ready Voyage AI + Pinecone implementation to dynamically inject financial context into the Bull agent's strategy evaluation. Included pipeline integration for 8-K filings.

## Why
The previous cloud-hosted RAG approach was removed to simplify architecture. However, we required high-fidelity embeddings (`voyage-finance-2`) to provide the LLM with relevant catalyst information (news, filings) before trade decisions. Pinecone acts as the vector backend for these high-dimensional financial context vectors.

## Files
- `src/lib/vector-db.ts` [NEW]: Client instantiation for Voyage and Pinecone, encapsulating `storeContext` and `retrieveContext` functions. Auto-creates the `robinhood-agentic` index on demand.
- `src/lib/web-sources/sec8k.ts` [MODIFY]: Wired `refreshEightK` to asynchronously call `storeContext` on freshly scraped SEC 8-K filings.
- `src/lib/strategy.ts` [MODIFY]: Updated `proposeTrades` interface to accept `ragContext`. Modified `runStrategyOnce` to query `retrieveContext` for the top 3 market candidates and supply them as a bundled RAG block. Injected this string cleanly into `bullSystemPrompt`.

## Verification
- Dependencies (`voyageai`, `@pinecone-database/pinecone`) validated.
- Pinecone and Voyage keys read automatically via `getUserApiKey(userId, "voyage")` or environment fallbacks.
- `tsc --noEmit` and `npm run build` pending validation.

## Follow-ups
- Hook up news feeds and FINRA short volume narratives to also feed into the `vector-db.ts` ingestion pipeline.
- Consider UI toggle in Settings for "Enable LLM RAG".
