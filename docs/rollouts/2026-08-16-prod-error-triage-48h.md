# 2026-08-16 — 48h production error triage (Pinecone daily write fuse)

## 1. Context & Objective

Owner asked to troubleshoot every app error from the last 48 hours, including the
"Usage limit hit: Pinecone Write Unit daily fuse" notification (2,513,588 of
2,500,000 estimated WUs).  A follow-up screenshot showed the Pinecone Standard
trial still healthy ($238.05 of $300 remaining, 14 days left).  Pinecone itself
should keep working.

## 2. Changes Made

The fuse is the **app-side** rolling-24h cap `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY`
(prod is at the trial value **2,500,000**, not the 200k code default).  Retrieval
was never down.  New upserts pause until the 24h window rolls.  Did **not** raise
the cap.

What burned the 2.5M: planned trial-scale ingest, not a dedup hole and not
repeated agent memory writes.  Live task journal at 2026-08-16T19:32Z showed
`roic-transcript-refresh` running, plus `web-source-refresh` and one
`filing-body-ingest` (5.5 min at 04:50Z).  The skipped batch (175 items / 2,698
estimated WUs) is one ~175-chunk document hitting an already-spent fuse.
`storeDocument` already reuses a committed generation before writing; ROIC skips
`ingested_accessions`.  `managed-vector-reconcile` is dry-run and does not upsert.

Code: park incremental lanes when the fuse is spent, and tell the truth in the
alert.

Touched files:

- `src/lib/vector-db.ts` — `hasPineconeWriteBudget`, honest fuse copy, early
  `storeDocument` refuse before `beginVectorCommit`
- `src/lib/web-sources/roic-transcripts.ts` — skip the fetch loop when the fuse is spent
- `src/lib/web-sources/sec-filings.ts` — same preflight as the text budget
- `src/lib/web-sources/fmp-transcripts.ts` — same
- `src/lib/web-sources/sec8k.ts` — same
- `src/lib/rag/sec-ingest-worker.ts` — daily fuse / text budget skip is a 1h deferral,
  not `Ingestion budget or capacity exceeded mid-task`
- tests for the above
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note

## 3. Decisions & Trade-offs

- Do not raise `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY`.  2.5M is the documented
  trial knob (see `docs/rollouts/2026-08-09-pinecone-trial-throughput-and-monthly-pace.md`).
  After trial the same note recommends 60k/day.
- Daily-fuse park is a 1h deferral on the SEC worker (the monthly breaker still
  uses `wuExhaustedUntil`).  Incremental ROIC/filing/8-K lanes just skip the tick
  and retry when due.
- TestFlight CI (FLEET-INFRA-BN) is archive-lock timeout on the shared Mac runner,
  not an app runtime error.  Left to the existing hourly-ship lane.

## 4. Verification State

```bash
./node_modules/.bin/vitest run \
  test/vector-db-document-receipts.test.ts \
  test/vector-db-backlog-c-integration.test.ts \
  test/sec-filings.test.ts \
  test/fmp-transcripts.test.ts \
  test/sec8k-full-body.test.ts \
  test/usage-limit-alerts.test.ts \
  test/sec-ingest-worker.test.ts
```

Targeted: 17+20+the producer files green.  Full land.sh gate (tsc / test / build)
runs before the PR.

## 5. Next Steps & Blockers

- After trial: drop `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY` toward 60k and set
  `PINECONE_MONTHLY_WU_BUDGET` (owner/Infisical).
- Residual owner: Litestream L2/L3 wedge (rolling deploy + B2 prefix).
- Residual CI: iOS TestFlight archive.lock timeout (FLEET-INFRA-BN).
- Residual transient (now healthy): congress.trade 502 during a deploy,
  filingapi 401, OpenRouter embed 500 / rerank `fetch failed`.
- Residual: `vix-yahoo` "active but no success in 60 min" — CBOE-first VIX is ok.
- Residual: Alpaca paper 422 sub-penny `24.865` (2026-08-14).

## 6. Zero-Code Findings

Sentry last 48h (socratic-trade + related):

| Issue | What | Verdict |
|---|---|---|
| SOCRATIC-TRADE-1T | Pinecone write unit budget reached | App fuse at 2.5M.  Pinecone trial healthy.  6h Sentry cooldown working (~5 events / 48h). |
| SOCRATIC-TRADE-1X | OpenRouter embed 500 | Transient provider 500.  Last 2026-08-15.  `rag-embed` healthy now. |
| SOCRATIC-TRADE-22 | OpenRouter rerank `fetch failed` | Transient.  Last 2026-08-14.  `rag-rerank` healthy now. |
| SOCRATIC-TRADE-1V / 1W | congress.trade / SSE HTTP 502 | During a 01:01Z deploy.  Both probes ok now. |
| SOCRATIC-TRADE-21 | filingapi HTTP 401 | Last 2026-08-14.  Probe ok now. |
| SOCRATIC-TRADE-S | Downtime detected | Resolved.  Last 14h before this note. |
| FLEET-INFRA-BN | iOS TestFlight ship | Archive lock timeout on the Mac runner.  Not an app outage. |
| Health storage | Litestream L2 empty/wedged, L3 upstream-wedged | Known owner deploy/B2 issue.  App `ok: true`. |
