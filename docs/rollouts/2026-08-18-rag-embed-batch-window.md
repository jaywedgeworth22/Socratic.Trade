# 2026-08-18 — rag-embed DeepInfra batch-window 400

## Context & Objective

After the 2026-08-18 2:12pm CT deploy, `rag-embed` hard-failed on `embed documents`.  Live `VECTOR_EMBED_BATCH_SIZE` is 32 (code default 8).  `storeContextsImpl` POSTed `{model, input: string[]}` to OpenRouter `baai/bge-m3`.  DeepInfra sums the **whole batch** against the 8192-token context.  A 32-text ingest hit 8193 and 400'd.  The same body still fired on `12e8dcd` after #2812.  Small later probes (17–59 tokens) succeeded.  Jay wants those documents embedded, not a prettier 400.  The #2812 health 503 gate stays.

## Changes Made

`embedWithRetry` no longer sends a count-only batch.  It packs each provider POST so `approxTokens` (UTF-8 bytes / 4) stays under ~7500, with a 18,750-byte cap so a `VECTOR_CONTEXT_MAX_CHARS=2400` batch cannot sneak past 8192 if DeepInfra tokenizes denser than bytes/4.  A single over-limit text is isolated, split into in-window pieces, embedded, and mean-pooled so the document still lands.  Infisical can keep `VECTOR_EMBED_BATCH_SIZE=32`.  Did not revert #2812 / #2829 / #2800.  Did not drop `rag-embed` from health.

Touched files:

- `src/lib/rag/embed-request-pack.ts`
- `src/lib/rag-metering.ts`
- `src/lib/vector-db.ts`
- `test/embed-request-pack.test.ts`
- `test/vector-db-chunk-cap.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-08-18-rag-embed-batch-window.md`

## Decisions & Trade-offs

- Pack at `embedWithRetry`, not only the `chunks(documentsToStore, embedBatchSize())` loop, so query embed and the reuse-exact missing-input path get the same guard.
- Mean-pool an isolated over-limit text so storeContexts still gets one vector per document (managed commit cardinality unchanged).  Prefer that over skipping the filing.
- Dual budget (7500 tokens + 18,750 bytes).  Token-only packing of 12×2400-char texts can still exceed 8192 if the real tokenizer is denser than bytes/4.
- Did not change the #2812 soft-degrade: one dead lane stays HTTP 200.  This PR makes the lane succeed.

## Verification State

```bash
npm test -- test/embed-request-pack.test.ts
# 8 passed
npm test -- test/vector-db-embedding-integrity.test.ts test/vector-db-chunk-cap.test.ts
npm run lint
npx tsc --noEmit
npm run build
```

Linux VM: no xcodebuild.  Do not claim an iOS compile.

## Next Steps & Blockers

- Land and let auto-deploy pick it up.  Confirm live `rag-embed` `ok=1` on ingest batches, not only 17–59-token probes.
- Leave Infisical `VECTOR_EMBED_BATCH_SIZE=32` unless an operator wants a smaller count for RPM.
- Do not reclassify this as an account-miss.  Do not drop rag-embed from health.

## Zero-Code Findings

First five hard fails after 19:12:31Z were the same 8193 `input_tokens` body (19:12:49Z, 19:12:59Z, 19:14:10Z, 19:14:18Z, 19:15:29Z).  Twelve hard fails through 19:31:57Z.  Then ok=1 from 19:33:40Z on tiny baai/bge-m3 probes.  Same 8193 body again at 20:03:58Z after the #2812 swap.  Path is ingest `embed documents`, not the health probe.
