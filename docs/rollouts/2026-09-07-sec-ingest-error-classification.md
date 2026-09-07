# 2026-09-07 - sec-ingest-error-classification

## Summary

Fixes three error-handling defects in the RAG/SEC ingest path, all filed 2026-08-23 by a
full-stack review pass and still unfixed at HEAD (`14eabced9`), plus a related Sentry
observability gap surfaced by production evidence while this work was in flight.

1. **P0 — SEC ingest dead-letters misclassify errors** (`src/lib/rag/sec-ingest-worker.ts:407-448`).
   Any non-complete `storeDocument` result that was not a recognized budget/quota condition was
   thrown as a generic `"Ingestion budget or capacity exceeded mid-task"` message. The
   `runTick` catch then dead-lettered it with `retryable: true` unconditionally, and the
   worker's own startup cleanup (`requeueSecIngestDeadLetters` in `start()`) revives any
   dead-lettered task whose `last_error` matches that literal string — so a genuinely
   permanent embed rejection (HTTP 400) was requeued and re-failed forever, filling the
   dead-letter queue with unrecoverable work while masking the real cause as a budget problem.

2. **P1 — query-embed failures return null and retrieval silently continues**
   (`src/lib/rag/search-fusion.ts` — `retrieveFusedContext`). `retrieveContextDetailed` already
   has a typed `RetrievalStatus`/`onStatus` receipt for `lookup_failed`/`budget_skipped`, but
   `retrieveFusedContext`'s hybrid dense+lexical fusion never wired it up: a query-embed
   400/429/connection failure came back as an empty `vectorResults` array indistinguishable
   from "no semantic match," and a thrown failure was swallowed by a bare
   `console.warn(...)`. The fused result silently proceeded lexical-only with no signal
   anywhere.

3. **P1 — incremental SEC refresh counts a skip as success even when an error is set**
   (`src/lib/web-sources/sec-filings.ts` — `refreshFilingBodiesUnlocked`). `ingestFiling` can
   return `{ skipped: true, error: "..." }` (e.g. `document-commit-proof-missing`/`-lost`) — a
   genuine failure that also happened to stop short of a full ingest. The aggregation checked
   `ingestResult.skipped` BEFORE `ingestResult.error`, so this case took the "skipped" branch
   and the error was never pushed into `result.errors`. The refresh reported success (an empty
   `errors` array) while a filing had actually failed, so monitoring never fired.

**Related observability gap** (found via production Sentry evidence gathered mid-fix,
`SOCRATIC-TRADE-27` / `SOCRATIC-TRADE-1X`): the "RAG ingest text budget reached" Sentry warning
(`src/lib/vector-db.ts`, inside `storeContextsImpl`) had no rate limiting, unlike its sibling
`alertRagConnectionFailure`. It fired 8,036 times in 2 days (roughly every 10-20s, matching the
SEC ingest worker's 5s tick × up to 5 tasks/tick against one persistent condition) while the real
underlying failure ("OpenRouter embed connection failed") surfaced only 5 times — burying the
real signal. Also, a genuine unclassified embed/connection failure was always logged at
`warning` level even when it was not a known rate-limit/billing/quota condition.

## Why

Guiding principle: classify errors by what they actually are, and fail loudly rather than
silently degrading. A 400 is permanent (the provider rejected the request itself; retrying the
identical request can never succeed) — dead-letter it immediately with its real reason. A 429
or connection failure is transient — back off and retry with the existing bounded
stage-attempts budget. Never let "budget exceeded" absorb unrelated failures.

For defect 2, deliberately chose **proceed degraded** over hard-failing the whole hybrid query:
`retrieveFusedContext` backs chat/dossier/proposer answer quality broadly, and a hard failure on
every transient embed hiccup would take down more than it protects. Instead the result is
marked degraded (`wasDenseRecallDegraded()`) and a structured `logError` + `recordEmbedFailure`
signal fires — visible, not silent.

## Files

- `src/lib/rag/sec-ingest-worker.ts` — real classify-and-fail instead of the generic budget throw.
- `src/lib/vector-db.ts` — `classifyEmbedFailure` classifier; threads the real embed failure
  message from `embedDocumentsLaneOrSkip` → `embedPackedInputGroups` → `storeContextsImpl`
  (`embedFailureMessage` field, kept separate from `error` which existing callers treat as "the
  whole call threw"); `alertRagConnectionFailure` now logs at `error` level for a genuinely
  unclassified failure instead of always `warning`; cooldown-gated the "RAG ingest text budget
  reached" Sentry capture and gave it its own fingerprint lane (`rag-ingest-budget`).
- `src/lib/rag/search-fusion.ts` — `retrieveFusedContext` tracks dense-recall degradation via
  `retrieveContextDetailed`'s `onStatus` callback and thrown errors; `wasDenseRecallDegraded()`
  exported for callers that want to check; structured `rag.dense_recall_degraded` log + metric.
- `src/lib/web-sources/sec-filings.ts` — `refreshFilingBodiesUnlocked` checks `ingestResult.error`
  before `ingestResult.skipped`.
- Tests: `test/sec-ingest-worker.test.ts`, `test/pinecone-metadata-and-rag-limits.test.ts`,
  `test/search-fusion.test.ts`, `test/sec-filings.test.ts`.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (804 pre-existing warnings, `warn`-only per `eslint.config.mjs`).
- `npm test` (vitest) — full suite green; see PR for count.

## Follow-ups

- The "RAG ingest text budget reached" cooldown/lane fix has no dedicated unit test — its
  sibling helper (`shouldEmitPineconeWuBudgetSentry`) is likewise untested in this codebase, and
  it does not change any existing control-flow branch (purely a fire-and-forget Sentry gate).
- Historical dead-lettered tasks whose `last_error` still matches the old generic budget message
  will be requeued once more by the existing startup cleanup and re-classified correctly on
  their next failure (one-time correction, not a new loop).

## Blockers

- None.
