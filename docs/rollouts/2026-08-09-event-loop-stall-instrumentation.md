# 2026-08-09 (~11:40pm CT) — prod event-loop stall during backfill: instrumentation + yields

## Context & Objective

Uptime Robot opened incidents on socratictrade.com during the trial backfill. Diagnosis: the
`next-server` process periodically pins at 100-110% CPU in state R for 11-85s (measured via
in-container health probes — first probe 85,211ms, subsequent ~110ms), freezing every request
including `/api/health`. The pin follows large filing ingests (`Indexed 1297/1297 context
document(s)` immediately preceded one stall window). The ingest pipeline (extract → chunk →
score → persist) runs synchronous CPU segments on the serving event loop, and the trial knobs
(200 filings/run, delay 0) chain them back-to-back. Exact hot spot is content-dependent —
candidates cleared so far: the summarizer's Jaccard diversity loop is O(n×8), not O(n²).

## Changes Made

- `src/lib/slow-sync-guard.ts` (new) — `timeSync(label, subject, fn)` warns `[slow-sync] <label>
  held the event loop <ms>ms (<subject>)` when a wrapped synchronous call exceeds 1s (warn-only,
  zero behavior change); `yieldEventLoop()` (setImmediate) for pipeline loops.
- Wrapped at definition (covers every caller): `extractFilingText` (sec-filings.ts),
  `tradeHighlightChunksFromText` (document-summarizer.ts), `chunkDocument` (chunk.ts).
- Yields between iterations: refresh lane per-filing loop (sec-filings.ts) and SEC ingest worker
  per-task loop (sec-ingest-worker.ts) — bounds pin length to ONE filing's synchronous work.

## Decisions & Trade-offs

- Deliberately did NOT blind-fix (input caps, worker threads) at this hour: instrumentation
  first so prod names the exact hot spot, then a targeted fix in daylight. Yields are the only
  behavioral change and only add scheduling points.
- Related observations from the same incident window: CT's outage was their stale-container
  resurrection (their RCA); ST slowness is OUR ingest, not box pressure (load ~1.4, 11G free).
  OpenRouter credits: $55.50 remaining of $165 — owner may want to top up; embed spend is
  negligible (~$0.13 tonight), the burn is LLM decision traffic.

## Verification State

- `npx tsc --noEmit` clean; targeted suites green (58 tests: sec-ingest-worker, sec-filings,
  document-summarizer/chunk). Full gates via `scripts/land.sh`.

## Next Steps & Blockers

- After deploy: grep container logs for `[slow-sync]` → the named hot spot gets the targeted
  fix (input cap, algorithmic fix, or worker_thread offload) BEFORE Monday market open if the
  stalls persist at length; verify Uptime Robot goes quiet.
