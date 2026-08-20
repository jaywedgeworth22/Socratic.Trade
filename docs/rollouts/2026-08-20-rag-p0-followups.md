# 2026-08-20 — RAG P0 follow-ups (parsed-text SEC, chat asOf, production eval path)

## Context & Objective

Owner asked to implement the P0 follow-ups from `docs/audits/2026-08-17-rag-learning-recall.md`: stop the SEC worker from embedding raw HTML, make chat retrieval pass `asOf` so `VECTOR_ASOF_STRICT` can fire, and score evals on `retrieveContextDetailed` (the Green/Red/chat path).

## Changes Made

- Shared `buildSecDocument` for incremental `ingestFiling` and `SecIngestWorker` — parsed/joined section text, never raw HTML.
- `getCikForTicker` uses `loadTickerCikMap` and returns null instead of sentinel `0000000000`.  `refreshFilingBodies` uses the same ticker→CIK map.
- Chat `searchKnowledge` always passes `asOf` via `resolveRetrievalAsOf` (question date or now).  Strategy Autopilot already passed `runAsOf`.
- Golden harness and a contract test now call `retrieveContextDetailed` with `strictAsOf: true`.  `eval:rag-production` remains the live corpus CLI.

Touched:

- `src/lib/rag/sec-document.ts`
- `src/lib/rag/retrieval-asof.ts`
- `src/lib/rag/sec-ingest-worker.ts`
- `src/lib/web-sources/sec-filings.ts`
- `src/lib/chat/orchestrator.ts`
- `scripts/eval/rag-eval-harness.ts`
- `test/rag-sec-document.test.ts`
- `test/rag-retrieval-asof.test.ts`
- `test/rag-production-path-contract.test.ts`
- `test/rag-eval-harness.test.ts`
- `test/chat-orchestrator-search-knowledge.test.ts`
- `test/sec-ingest-worker.test.ts`
- `test/sec-filings.test.ts`
- `docs/audits/2026-08-17-rag-learning-recall.md`
- This note, STATUS, PLAN, effort log, `docs/phase-7-strategy.md`

## Decisions & Trade-offs

- Did not default `asOf` inside `retrieveContextDetailed` itself (would change every omitted-asOf test and the documented "unset = no PIT" contract).  Callers that must be live-dated now pass it.
- Ticker desk still has no RAG retrieve (v2).  Chat + Autopilot are the live retrieve surfaces.
- Did not enable `SEC_INGEST_WORKER_ENABLED`.
- Did not raise the Pinecone daily WU fuse.

## Verification State

Targeted vitest for the new/changed files, then the full gate (`npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`) before claiming done.

## Next Steps & Blockers

S5 8-K feed, L1/L2 memory decay wiring, production gold-set expansion.  Staging proof that worker `storeDocument` text is tag-free before enabling the worker.

## Zero-Code Findings

None — this follow-up is product code.
