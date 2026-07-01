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

## Gated upgrade 1b — corpus enablement (full-filing bodies + disclosures)

**This is a config/cost decision, not a code change — the code is already wired end-to-end and
tested against fixtures; nothing here flips a default on.** The audit (`docs/reviews/2026-06-30-improvement-audit.md`
§6.3) identified the RAG corpus as the binding constraint on retrieval quality. **Framing correction
(2026-07-01 expert review):** the corpus is not empty — the 6-line 8-K **summary** ingest
(`sec8k.ts`, `doc_type:"8-k"`) always runs, unconditionally, with no flag. The gap is *depth*: the
structure-aware `chunkDocument`/`storeDocument` **full-body** pipeline (full 10-K/10-Q/8-K text,
not just a summary line) sits mostly idle behind default-off flags/throttles.

**Rank the levers by trading value (highest first) — not all three matter equally:**
1. **10-K/10-Q full-body** (`src/lib/web-sources/sec-filings.ts`, `refreshFilingBodies`) — the
   highest-value lever: full risk-factor/MD&A/financial-notes text, not a 6-line summary. No separate
   on/off flag — gated purely by the free-tier throttle (see the coupling trap below).
2. **8-K full-body** (`WEB_SOURCE_SEC8K_FULL_BODY`, capped at 5 filings/cycle via
   `WEB_SOURCE_SEC8K_FULL_BODY_LIMIT`) — full material-event filing text instead of the summary line.
3. **Disclosures** (`RAG_EMBED_DISCLOSURES`) — congressional-trade/insider-filing one-liners; lowest
   marginal value of the three, but cheapest to enable.

**What full-body ingest actually needs to run well (not just be enabled):**
1. A **paid Voyage key** — the free tier is 3 requests/minute (`VECTOR_EMBED_BATCH_DELAY_MS` defaults
   to 21000 = one embed batch per 21s). Full-filing bodies are 10-100x more chunks per document than
   the 8-K summary line, so free-tier throughput makes body ingest impractically slow (the free-tier
   gate below caps it to 1 filing/tick specifically because of this).
2. Set `VECTOR_EMBED_BATCH_DELAY_MS=0` (and optionally raise `VECTOR_EMBED_BATCH_SIZE` toward
   Voyage's 128-input cap) once the paid key is active — this is also the signal `sec-filings.ts`'s
   `isFreeTier()` reads to lift its own 1-filing-per-tick throttle (`PAID_KEY_THRESHOLD_MS = 5000`;
   anything ≤ 5000ms is treated as "you have a paid key").

**Two operator traps, verified against current code (2026-07-01 expert review) — read before flipping anything:**
- **Trap 1 — the batch-delay flag has a SECOND side effect.** Setting `VECTOR_EMBED_BATCH_DELAY_MS=0`
  to speed up ingestion ALSO flips `sec-filings.ts`'s `isFreeTier()` gate, which **enables 10-K/10-Q
  full-body ingestion** (previously capped at 1 filing/tick). If you only intended to speed up
  8-K/disclosure embedding and are not ready for 10-K/10-Q full-body cost, do not set this to 0 — or
  do, deliberately, understanding it turns on the highest-value (and highest-cost) lever above.
- **Trap 2 — `RAG_EMBED_DISCLOSURES` parses differently from the other two flags.**
  `disclosureRagEnabled()` (`disclosure-rag.ts:18-21`) requires the **exact string `'on'`**
  (case-insensitive), NOT the `1`/`true`/`on`/`yes` set that `VECTOR_ENABLE_RERANK` and
  `HYBRID_RETRIEVAL` accept. Setting `RAG_EMBED_DISCLOSURES=true` **silently no-ops** — no error, no
  warning, disclosures just never embed. Use exactly `RAG_EMBED_DISCLOSURES=on`.

**Env vars to flip (all currently default OFF/free-tier):**
| Var | Default | Paid-tier value | Effect |
|---|---|---|---|
| `VECTOR_EMBED_BATCH_DELAY_MS` | `21000` | `0` | Removes the free-tier Voyage throttle; ALSO the paid-key signal `isFreeTier()` reads — see Trap 1. |
| `VECTOR_EMBED_BATCH_SIZE` | `8` | up to `128` | Bigger embed batches once the paid key removes the RPM ceiling. |
| `WEB_SOURCE_SEC8K_FULL_BODY` | `off` | `on` | Ingest the FULL 8-K filing body (not just the 6-line summary) via `storeDocument`/`chunkDocument`. |
| `WEB_SOURCE_SEC8K_FULL_BODY_LIMIT` | `5` | raise as budget allows | Cap on how many fresh 8-Ks get full-body ingest per refresh cycle. |
| `RAG_EMBED_DISCLOSURES` | `off` | **exactly** `on` | Embed congressional-trade + insider-filing disclosures as RAG documents (`disclosure-rag.ts`) — see Trap 2, `true`/`1`/`yes` do NOT work. |

**10-K/10-Q bodies** (`src/lib/web-sources/sec-filings.ts`, `refreshFilingBodies`) don't have a
separate on/off flag — they're gated purely by the free-tier throttle above (1 filing/tick on free
tier via the scheduler at `src/lib/scheduler.ts:183`; up to `maxPerRun` on paid tier). Flipping
`VECTOR_EMBED_BATCH_DELAY_MS` to `0` is what unlocks their throughput (see Trap 1).

**Rough cost (from `docs/chat-assistant-rag-learning.md` §7, verify current pricing before committing
spend):** embeddings ~$15-55 one-time to re-embed the existing filing set on Voyage; Pinecone
~$5-30/month recurring depending on corpus depth and query volume. The free Voyage 3 RPM tier is the
real practical gate — a paid key removes it cheaply relative to the ingestion time it saves.

**How to verify corpus growth after flipping the flags (no guessing):**
1. Confirm the flags took effect: `WEB_SOURCE_SEC8K_FULL_BODY=on` (env), Voyage key is a paid key.
2. Let at least one scheduler tick / one `POST /api/admin/reindex-10k` run pass.
3. Check `GET` on the Pinecone stats route (or call `getVectorStoreStats()` directly) and confirm
   `totalVectorCount` increased from its pre-enablement baseline.
4. Check the `document_chunks` / `ingested_accessions` tables (`db-learning.ts`) for new rows —
   `listIngestedAccessions` — confirms specific filings were actually chunked+embedded, not just
   attempted.
5. Check the `vector_store` / `sec_filing_ingest` / `disclosure_rag_embed` audit rows (`audit()` calls
   in `vector-db.ts`, `sec-filings.ts`, `disclosure-rag.ts`) for `ok:true` and a non-zero `indexed`
   count — a silent Voyage 429 or Pinecone error still shows up here even if nothing else does.

**Test coverage proving the enablement path itself works (fixtures only, no live calls):**
`test/sec8k-full-body.test.ts` drives `ingestEightKBody`/`ingestEightKBodies` with
`WEB_SOURCE_SEC8K_FULL_BODY` toggled and a mocked EDGAR fetch + mocked `storeDocument`, asserting the
full-body path actually calls `storeDocument` with the right `doc_type`/`source` and records the
accession de-dup row. `test/disclosure-rag.test.ts` already covers `RAG_EMBED_DISCLOSURES=on` calling
`storeContexts` end-to-end against a mock.

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
