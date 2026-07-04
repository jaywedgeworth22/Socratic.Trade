# Voyage + Pinecone: production tuning & gated upgrades

The RAG/memory stack uses **Voyage** for embeddings + reranking and **Pinecone** for the vector
store. Out of the box it runs at high quality with the current key; two upgrades are **gated** behind
an owner decision because they cost money and/or require a reindex.

## What's on by default (no action needed)
- **Embeddings:** `voyage-finance-2` (1024-dim) — a finance-domain model, correct `input_type`
  (document vs query).
- **Pinecone index:** `socratic-trade` — dense/cosine/1024. Pinecone index names must be lowercase,
  so the resource is lowercase even though the product name is "Socratic Trade".
- **Reranking:** ON (`VECTOR_ENABLE_RERANK=on`, `VOYAGE_RERANK_MODEL=rerank-2.5`). Pinecone
  over-fetches by cosine recall, then Voyage's cross-encoder reorders by true relevance. Fails safe
  to cosine order on any error. This is the single biggest retrieval-quality lever.
- **Write guardrails:** RAG ingestion caps are ON by default: `SEC_FILING_RAG_MAX_PER_RUN=1`,
  `RAG_INGEST_BUDGET_ENABLED=on`, `RAG_INGEST_MAX_TEXTS_PER_DAY=1000`,
  `VECTOR_STORECONTEXTS_DEDUP=on`, `RAG_PINECONE_WRITE_BUDGET_ENABLED=on`, and
  `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY=50000`. The Pinecone WU budget is checked before Voyage
  embedding, so an exhausted vector-store budget does not also burn embedding tokens.
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
alert. No code change, no reindex. Paid-mode speed does **not** mean unbounded ingestion: the
per-run filing cap and 24h text cap still apply.

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

**Operator traps — read before flipping anything:**
- **Trap 1 — the batch-delay flag has a SECOND side effect.** Setting `VECTOR_EMBED_BATCH_DELAY_MS=0`
  to speed up ingestion ALSO flips `sec-filings.ts`'s `isFreeTier()` gate, which **enables 10-K/10-Q
  full-body ingestion**. It is still capped by `SEC_FILING_RAG_MAX_PER_RUN` (default `1`) and
  `RAG_INGEST_MAX_TEXTS_PER_DAY` (default `1000`). If you only intended to speed up
  8-K/disclosure embedding and are not ready for 10-K/10-Q full-body cost, do not set this to 0 — or
  do, deliberately, understanding it turns on the highest-value (and highest-cost) lever above.
- **Trap 2 — retrieval budget is not an ingest budget.** `RAG_RUN_BUDGET_ENABLED` degrades retrieval
  extras like rerank/hybrid; it does not stop ingestion writes. Use `RAG_INGEST_BUDGET_ENABLED` and
  `RAG_INGEST_MAX_TEXTS_PER_DAY` for text volume, and `RAG_PINECONE_WRITE_BUDGET_ENABLED` /
  `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY` for Pinecone write-unit volume.
- **Trap 3 — agents can write filings/memory directly.** Pinecone writes are not limited to the
  admin RAG pages. The scheduler calls `refreshFilingBodies` for 10-K/10-Q body chunks; `refreshEightK`
  stores 8-K summaries and, if enabled, full 8-K bodies; `embedDisclosures` can write congress/insider
  disclosure documents; and Socratic decisions are indexed as private memory. Keep the shared write
  budgets on before connecting a fresh Pinecone account.

**Env vars to flip (all currently default OFF/free-tier):**
| Var | Default | Paid-tier value | Effect |
|---|---|---|---|
| `VECTOR_EMBED_BATCH_DELAY_MS` | `21000` | `0` | Removes the free-tier Voyage throttle; ALSO the paid-key signal `isFreeTier()` reads — see Trap 1. |
| `VECTOR_EMBED_BATCH_SIZE` | `8` | up to `128` | Bigger embed batches once the paid key removes the RPM ceiling. |
| `SEC_FILING_RAG_MAX_PER_RUN` | `1` | raise deliberately | Hard cap on 10-K/10-Q filings processed per scheduler run, including paid mode. |
| `RAG_INGEST_BUDGET_ENABLED` | `on` | keep `on` | Enables the 24h text-count cap before any Voyage/Pinecone write. |
| `RAG_INGEST_MAX_TEXTS_PER_DAY` | `1000` | raise deliberately | Max texts embedded/upserted per 24h by the shared RAG ingest path. |
| `RAG_PINECONE_WRITE_BUDGET_ENABLED` | `on` | keep `on` | Enables the 24h estimated Pinecone Write Unit cap before any Voyage embed call. |
| `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY` | `50000` | raise deliberately | Default allows normal single-user operation while keeping a 2M-WU Starter account from being exhausted by a write loop. |
| `VECTOR_STORECONTEXTS_DEDUP` | `on` | keep `on` | Skips unchanged 8-K/disclosure summaries before embedding. |
| `WEB_SOURCE_SEC8K_FULL_BODY` | `off` | `on` | Ingest the FULL 8-K filing body (not just the 6-line summary) via `storeDocument`/`chunkDocument`. |
| `WEB_SOURCE_SEC8K_FULL_BODY_LIMIT` | `5` | raise as budget allows | Cap on how many fresh 8-Ks get full-body ingest per refresh cycle. |
| `RAG_EMBED_DISCLOSURES` | `off` | `on` | Embed congressional-trade + insider-filing disclosures as RAG documents (`disclosure-rag.ts`). Accepts `on`/`true`/`1`/`yes`. |

**10-K/10-Q bodies** (`src/lib/web-sources/sec-filings.ts`, `refreshFilingBodies`) don't have a
separate on/off flag — they're gated by the free-tier throttle above plus the explicit
`SEC_FILING_RAG_MAX_PER_RUN` cap. Flipping `VECTOR_EMBED_BATCH_DELAY_MS` to `0` is what unlocks
their throughput, not permission to ingest unlimited filings (see Trap 1).

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
5. Check `/admin/connections` for `pinecone`, `voyage`, and `voyage-rerank` health, and
   `/admin/rag-coverage` for vector-store errors, last-ingest errors, and ingest-budget skips.
6. Check the `vector_store` / `vector_ingest_budget` / `sec_filing_ingest` /
   `disclosure_rag_embed` audit rows for `ok:true`, non-zero `indexed`, or explicit budget/failure
   reasons.

## Usage reporting reality

The app's RAG Usage table is an **app-recorded ledger**, not the provider invoice:

- Voyage usage docs point operators to the Voyage/Atlas dashboard for provider-account usage. The app
  estimates tokens/cost only for calls it made after local metering existed.
- Pinecone query responses can expose per-request Read Units, and the app records those when available.
  Pinecone upsert responses do not give a monthly org Write Unit total through the normal app SDK path,
  so the app records estimated WUs and shows live index inventory as a cross-check.
- Pinecone org-month quota usage still must be verified in the Pinecone console unless/until a provider
  billing/usage API becomes available for this plan/key.
- If provider usage is high and app-recorded usage is low, assume one of: older calls before metering,
  another process/worktree/index, failed local ledger writes, or provider-side indexing not represented
  by the local `document_chunks` ledger.

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
