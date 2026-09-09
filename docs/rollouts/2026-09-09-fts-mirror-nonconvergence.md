# 2026-09-09 — FTS mirror never converged, pinning the event loop into a public 503

## Symptom

Production `/api/live` measured from inside the Docker network: **8.60s, then 0.09s, then
0.03s** — all HTTP 200.  `/api/health` measured **8.41s** against 0.43s on 09-07.  The
container healthcheck (`curl /api/live`, timeout 5s, retries 3) timed out repeatedly,
Docker marked the container `unhealthy` (`FailingStreak: 5`), and Traefik pulled a
perfectly healthy container out of rotation.

Application internals were healthy throughout: `db: ok`, `schedulerAgeSeconds: 60`,
`schedulerStale: false`, all Alpaca streams authenticated, Litestream replicating every few
seconds.  Container CPU **107%** (one core saturated) with host disk `%util 0.10` — so the
process was **CPU-bound in-process, not IO-bound**.

Live characterisation from the host, 90 samples at 1s (2026-09-09 14:15–14:19 UTC):

```
14:15:50 14.35s   14:16:12 30.00s   14:16:43 22.35s   14:17:41 30.00s   14:18:15 16.63s
14:18:33 → 14:19:20  every sample 0.010–0.024s
14:19:21  6.30s
```

Bursts of multi-second stalls separated by stretches where the same endpoint answers in
10–20 ms.  That is a blocked event loop, not slowness.

## Root cause

`mirrorFtsChunksBounded` (and the same inline loop in `sec-ingest-worker.ts`) resumed from
`countDocumentChunkFts()` — a `COUNT(*)` of `document_chunks_fts_index` — and used that
count as a **positional offset into the chunk array**.

Those two numbers are only equal when every chunk in a document has a distinct
`content_hash`.  The index PK is `(content_hash, symbol, source, accession)`, so two
byte-identical chunks inside one filing — repeated table headers, boilerplate, empty
sections — collapse onto **one** row.  From the first duplicate onward the count is
permanently smaller than the position, the offset can never advance past it, and the same
slice is re-mirrored on every ingest tick forever.

`better-sqlite3` is fully synchronous, so each pass holds the serving event loop for its
entire duration.

### Production evidence

`[worker] ftsMirrorSlice took Nms for <doc> (<start>-><end>/<total> chunks)` in
`/app/data/litestream-runtime.log`, across six days:

| Document | Chunks | Resume offset, every single slice | Slices logged |
|---|---|---|---|
| `hsy-20260329.htm` | 508 | **400** (one slice pinned 36,511 ms) | 29 |
| `hsy-20251231.htm` | 1291 | **732** | 6 |
| `abnb-20260630.htm` | 448 | **355** | 42 |
| `dash-20250630.htm` | — | **358** | 58 |

Read back read-only from production `app.db`, `countDocumentChunkFts` returns exactly
`400`, `732` and `355` for those occurrences — the offsets match the log to the row.

Because `mirror.complete` never became true, `insertIngestedAccession` never ran, so the
worker re-queued the same filings indefinitely.  That is also the source of the 3,128
`[SecIngestWorker] ... failed: Ingestion budget or capacity exceeded mid-task` lines.

Total event loop pinned by this loop, per day:

| Day | Slices | Total pinned | Max single pin |
|---|---|---|---|
| 2026-09-04 | 21 | 121,246 ms | 32,791 ms |
| 2026-09-05 | 35 | 202,002 ms | 22,518 ms |
| 2026-09-06 | 43 | 338,843 ms | 32,695 ms |
| 2026-09-07 | 56 | 239,114 ms | 36,511 ms |
| **2026-09-08** | **198** | **1,317,546 ms (22 min)** | 32,196 ms |

This is a **regression by accumulation, not by commit**.  Every document that hits a
duplicate chunk joins a set that is retried forever and never leaves it, so the daily cost
grows monotonically.  09-08 is where it crossed the 5s healthcheck budget often enough to
trip `FailingStreak: 5`.

### Second defect found on the same path

`countDocumentChunkFts` filters `WHERE symbol = ? AND source = ? AND accession = ?`, but
the only index on `document_chunks_fts_index` is its PK, which **leads with
`content_hash`**.  The occurrence lookup therefore cannot seek.  Measured read-only against
production (689,047 rows, 10.98 GB DB):

```
EXPLAIN QUERY PLAN -> SCAN document_chunks_fts_index USING COVERING INDEX ...
timing              -> 78–105 ms per call, synchronous, once per document per tick
```

## Ruled out

- **`storeContexts` content-hash dedup** (the `870/870 document(s) already indexed`
  line).  Refuted by measurement: `SELECT content_hash FROM document_chunks WHERE
  content_hash IN (870 placeholders)` resolves via `SEARCH ... USING COVERING INDEX
  sqlite_autoindex_document_chunks_1` in **2–4 ms** on production.  It is a marker that a
  `storeContexts` call happened, not a cost.
- **PR #3192 (R2 cold snapshot, merged 09-08 12:03).**  `reportR2WeeklyFreshness()` is a
  single internal-setting read on a tick where nothing changed, and the `VACUUM INTO`
  already runs in a child process.  The scheduler `r2-cold-snapshot` lane's own journal
  rows are 13 ms average / 1,254 ms max.
- **A heavy `/api/health`.**  Re-measured live at **45 ms**; the 8.41 s reading was the
  blocked loop, not the endpoint.
- **SQLite lock contention (`database is locked`, 377 events over 5.4 days).**  Tested and
  refuted three ways.  (1) **Zero** such events during the measured 14:03–14:19 stall
  burst.  (2) Anti-correlated with the damage: 09-07 had *more* lock events (150) than
  09-08 (105), while 09-08 had 5.5x the pinning.  (3) SQLite's busy handler **sleeps**, so
  a lock wait shows low CPU — the measurement was 107% CPU with an idle disk, which is
  CPU-bound work, not waiting.  `db.ts` also notes the WAL-snapshot-upgrade path returns an
  *instant* `SQLITE_BUSY` that `busy_timeout` never applies to, so these are ~0 ms failures
  rather than 60 s parks.  They are a real but separate ingest-retry issue.

## Fix

1. **`ftsMirrorResumeOffset(rows, key)`** (`src/lib/db-learning.ts`) — resume on
   **content**, not on a count: the offset is the first row whose `content_hash` is not yet
   indexed for that occurrence.  Progress is provably monotonic, because mirroring a row
   indexes its hash, so the next resume is strictly greater and the loop always terminates.
   Wired into `src/lib/rag/mirror-fts-bounded.ts` and `src/lib/rag/sec-ingest-worker.ts`.
2. **Migration 88** — `idx_document_chunks_fts_index_occurrence ON
   document_chunks_fts_index (symbol, source, accession)`, turning that `SCAN` into a
   `SEARCH`.

No trading logic, no timeout widening (that mitigation shipped separately in PR #3201).

## Measurement

Resume query at production scale (689,047 rows), reproducing the production plan exactly:

| | Plan | Median | Max |
|---|---|---|---|
| Before | `SCAN ... USING COVERING INDEX` | 61.82 ms | 76.79 ms |
| After | `SEARCH ... USING idx_document_chunks_fts_index_occurrence` | **0.74 ms** | 3.29 ms |

**83.8x** less blocked event loop per document per tick, and the non-convergent retry loop
that produced 198 slices and 22 minutes of pinning on 09-08 is eliminated outright.

## Verification

- `test/fts-mirror-convergence.test.ts` — 4 new tests.  Pins the old failure directly
  (`countDocumentChunkFts` returns 6 where the position is 12), asserts the new offset is
  12, asserts `mirrorFtsChunksBounded` reaches `complete` with a strictly monotonic offset,
  and asserts the migration-88 plan is a `SEARCH`.
- `npx tsc --noEmit` — 0 errors.
- `test/sec-ingest-worker.test.ts`, `hydrate-accession`, `corpus-wide-lexical`,
  `sec-filings` — 101 passed.
- `persistence-hardening`, `db-migration-old-schema`, `db-migration-busy` — 27 passed
  (schema-version pins bumped 87 → 88).

## Follow-up not taken here

A single oversized FTS5 row can still pin the loop for its own tokenisation cost; the batch
sizer already floors at one row.  Moving the FTS mirror onto a worker thread with its own
connection is the durable fix and is out of scope for this incident.
