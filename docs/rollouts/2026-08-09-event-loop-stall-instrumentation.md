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

## Follow-up (2026-08-10 ~12:15am CT) — hot spot FOUND and fixed: cheerio on inline-XBRL monsters

Post-deploy evidence: in-container health still froze up to 20s with ZERO `[slow-sync]` lines —
the pin was in uninstrumented code. Traced to `parseFilingHtml` (`sec-parser.ts`): `cheerio.load`
builds a full DOM then `$("*").each` walks every node; inline-XBRL 10-Ks run 15-50MB with
millions of tags, giving the observed 11-85s synchronous pins in the worker's parse checkpoint
(matches the 846MB RES memory profile too). Fix: `SEC_PARSE_CHEERIO_MAX_BYTES` (default 5MB) —
oversize documents skip cheerio entirely and take the single-pass regex `extractFilingText`
(the exact text path the refresh lane already ships to RAG) as one FULL section. Also wrapped
`parseFilingHtml` in `timeSync` so the remaining cheerio path stays observable. New test:
oversize routing (`test/sec-parser.test.ts`). The sec-parser↔sec-filings import is circular by
function-body use only — safe.

## Overnight resolution state (2026-08-10 ~1:10am CT) — site stable, ingest PAUSED, diagnosis continues in daylight

The cheerio cap (PR #2606) deployed and is live (image sha == main HEAD), but resuming the
ingest still froze in-container health >20s with ZERO `[slow-sync]` lines — a third
uninstrumented synchronous stretch pins the loop. Remaining suspects, in order: (1) the
`storeContexts` SQLite commit phase (one big better-sqlite3 transaction: chunk_occurrences +
document_chunks + FTS5 tokenization + embed_stage blobs for 1,000+ chunks); (2) `ingestCompanyFacts`
(multi-MB `res.json()` + possibly unbatched per-fact SQLite inserts, runs per task); (3) worker
`JSON.parse(sectionsJson)` on ~30MB artifacts. Could also be a DB write-lock convoy rather than
CPU (health reads blocked behind the mega-transaction) — the 20s freezes match curl's cap, not
necessarily CPU pinning; instrument BOTH (wrap the commit transaction + facts stage in timeSync,
and log DB wait times) before re-enabling.

Operational state to restore later: `SEC_INGEST_WORKER_ENABLED=off` and
`SEC_FILING_RAG_MAX_PER_RUN=0` are set in Infisical (site-protective pause); flip back to
`on`/`200` + `docker restart` after the next fix lands. During the outage window a Coolify
rolling deploy + manual `docker restart` briefly left TWO app containers running (dual-scheduler
hazard) — resolved by stopping AND REMOVING the stale one; always `docker ps | grep d83b1ay`
after mixing restarts with deploys. Queue is durable (3,789 tasks parked); trial has ~20 days.

## Round 3 (2026-08-10 ~3:20am CT) — lock-window fix + full sync-path instrumentation

Key structural find: the refresh lane's FTS mirror ran `chunkDocument` (multi-second CPU on big
filings) INSIDE `runWithActiveVectorCommitProof`, which wraps its callback in ONE SQLite write
transaction — so the write lock was held for the whole chunking pass and every other writer
(including request-path telemetry) queued behind it on busy_timeout. That is a lock-convoy
mechanism fully consistent with the observed in-container health hangs that produced no
`[slow-sync]` lines. Fixed: chunks are computed BEFORE the transaction; the FTS mirror block is
timeSync-wrapped as a whole (loop-aggregate visibility).

Also instrumented (warn ≥1s, zero behavior change): `ingestCompanyFacts`'s triple-nested
facts transaction (per-task, multi-MB JSON walk — remaining prime suspect),
`persistDocumentReceipts` (chunks+occurrences receipt transaction), `stageEmbeddedVectors`
(embed-stage blob writes), and the worker's sections `JSON.parse` (~30MB artifacts).

Next: after deploy, controlled re-enable (worker on, refresh still 0) with live health watch —
the logs now name any residual pin; disable again if stalls recur.

## Separate finding (2026-08-10 ~4:40am CT) — litestream compaction contention, INDEPENDENT of SEC ingest

While SEC ingest was fully paused (worker off, refresh 0, zero SecIngestWorker log lines for
15+ min) the site still went unresponsive (external AND in-container health both timed out at
20s x3; `next-server` was at 32% CPU — not pinned — while curl probes queued and never
returned). This rules out the ingest pipeline as the cause of THIS stall and points at a
different mechanism: `better-sqlite3` does synchronous file I/O on Node's single thread, so if
litestream (a separate OS process) briefly holds an OS-level lock on the SQLite file during WAL
checkpoint/compaction, the app's synchronous DB calls — and therefore the whole event loop,
including serving `/api/health` — can block until the lock releases.

Evidence: the container logged `compaction failed: non-contiguous transaction ids` errors at
09:15:43 and 09:37:41 UTC; the second lands inside the observed stall window. Separately, and
NOT the direct cause (already gone by restart): the PREVIOUS container instance was stuck
retrying the exact same broken compaction (byte-identical transaction-id range) every 5 minutes
for 95+ minutes (08:05-09:40 UTC, `db=prod.db` in that container's log) without ever recovering
— a genuinely stuck litestream state that a restart cleared.

Action taken: `docker restart` (site restored, 200s at 0.2-0.5s sustained over 32s). No code
change yet — this needs daylight investigation (litestream version/log-level review, whether
`busy_timeout` on the better-sqlite3 connection is long enough to ride out a compaction window,
whether the l0-retention/compaction cadence can be tuned). Filed separately from the SEC-ingest
stall work above; do not conflate the two root causes.

## Round 4 (2026-08-10 ~5:05am CT) — worker FTS mirror batched; live repro caught the exact symptom

Controlled re-enable (worker on, refresh lane still 0, live health+log watch armed) reproduced
the stall in minutes: repeated `[SecIngestWorker] Task ... failed: Failed to advance checkpoint
from embed_queued to embedded`, each landing at the same timestamp as a health stall/timeout.
Root-caused the mechanism: `advanceSecIngestTask`'s UPDATE requires `lease_expires_at > now`; the
lease heartbeat is a `setInterval`, which literally cannot fire while the event loop is blocked —
so ANY long synchronous stretch anywhere in the process (including the litestream lock
contention documented above) can silently expire an in-flight task's lease, and this specific
error is the resulting SYMPTOM, not necessarily an independent new cause.

That said, the `embed_queued` handler's own FTS mirror loop was itself unbatched: one
`insertDocumentChunkFts` call per chunk, each its own auto-commit transaction — for a filing with
hundreds of chunks that's hundreds of sequential SQLite write-lock acquire/release cycles on the
hot path, each a fresh chance to contend with a concurrent litestream WAL checkpoint. Fixed: new
`insertDocumentChunkFtsBatch()` (db-learning.ts) wraps the whole document in ONE transaction;
the worker now calls it instead of looping, `timeSync`-wrapped for visibility. New tests confirm
byte-identical output vs the per-chunk loop.

Re-enable attempt disabled again after ~3 min (site + worker both paused) once the pattern was
confirmed — this fix needs its own controlled re-enable pass before considering the incident
closed. Op note: applying `SEC_INGEST_WORKER_ENABLED` via Infisical alone does NOT take effect
until the container restarts — always pair the env change with `docker restart`.
