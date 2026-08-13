# 2026-08-13 — Hotfix: adaptive FTS-mirror batching (ingest event-loop pinning recurrence)

## Context & Objective

Re-enabling the SEC ingest worker (owner directive) reproduced the 2026-08-10 event-loop stall: `ftsMirrorBatch took 119287ms (yielded)` for one 702-chunk 10-K, container CPU pinned ~102% for hours, site flapping 503.  The 08-10 fix (40-row groups + setImmediate yields) was insufficient because FTS5 tokenization cost is text-size-dependent — ~165ms PER ROW on big filings makes a 40-row group a ~6.6s synchronous stretch, and ~18 yields across 119s starves the HTTP server into edge 503s.  Relief applied first (worker off + container restart, site healthy 19:13Z); this PR is the cure that lets the worker come back.

## Changes Made

- `src/lib/db-learning.ts` `insertDocumentChunkFtsBatch`: group size is now ADAPTIVE against a 250ms wall-time budget per synchronous stretch — halve after a slow group (floor 1), double after a fast one (ceiling 40), hold in the comfort band.  Policy extracted as pure `nextFtsBatchGroupSize` for deterministic tests.  Worst case a single oversized row still costs its own tokenization time; never a whole group of them.
- `test/sec-ingest-worker.test.ts`: four policy tests incl. a convergence case shaped like the live incident (165ms/row halves 8→1 within three groups).

## Verification State

- `npx tsc --noEmit` clean; `npx vitest run test/sec-ingest-worker.test.ts` 10/10.  Full trio via `scripts/land.sh` at push; `verify` CI re-runs before merge.

## Next Steps & Blockers

- After this deploys: re-enable `SEC_INGEST_WORKER_ENABLED` and watch the first sync — stretches should be ≤~250ms (plus one worst-case row) and the site steady.  The ct-deploy-guard coalescer has been eating webhook deploys on ST — verify the deploy actually lands and retrigger via API if not.
