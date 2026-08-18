# 2026-08-18 — getAccounts 6s abort vs live p95 + ftsMirrorSlice loop pin

## Context & Objective

ASC discarded the hung-sidecar / MCP hypothesis.  There is no Alpaca sidecar.  The gateway is in-process on `socratic-app` (live `581467e1`, pid 2701530, started 4:12pm CT).  Paper / Roth are REST `alpaca`, not `alpaca-mcp`.  alpaca-broker was 500/500 ok this process, but 191/500 calls were ≥6s (avg ~3.1s, max 14s).  `ftsMirrorSlice` held the same event loop 6–12s.

Manual Run once still fail-closes on `Timed out waiting for gateway.getAccounts after 6000ms`.  That is an app-side deadline on a busy in-process loop, not a missing credential and not a missing sidecar.

## Changes Made

Investigated first (ops snapshot `asOf` 2026-08-18T22:31:35Z + ASC + code):

- Paper `PA33IDTHMFK9` and Roth `294709855` are `broker: alpaca`.
- `accountReadinessForSnapshot` fail-closes Manual Run once on `brokerAccountReadError` **or** `portfolioReadError`.
- Recoverable issues still show `dashboard.getAccounts · … after 6000ms` through 22:03:01Z.  After #2845 (`d4299bec`), portfolio still timed out at 22:10:15Z (`after 8000+7000ms`).  The 15s combined retry is still tighter than live max 14s plus a 6–12s FTS pin.
- `FTS_MIRROR_TICK_BUDGET_MS` was 6000 — the same number as the getAccounts first abort.  The planner used `Math.max(1, floor(remaining/msPerChunk))`, so 1ms remaining still started a chunk.  `insertDocumentChunkFtsBatch` started at an 8-row group; the 250ms stretch only adapts **after** that group finishes.  That is the 6–12s `ftsMirrorSlice` pin.

Fix:

- First wait 16s (above live max 14s) on dashboard getAccounts, portfolio bundle, and Alpaca `getAccount`.  Retry remains for a hung pending call.  Credential / 401 throws still fail immediately.  Timeout strings stay honest (`16000+8000ms`).
- FTS tick budget 2s, max 6 chunks, inner group 1.  Batch helper starts at 1 row.  Planner returns 0 chunks when remaining budget is below expected ms/chunk.

- `src/lib/inflight-deadline.ts`
- `src/lib/dashboard.ts`
- `src/lib/alpaca.ts`
- `src/lib/rag/fts-mirror-bound.ts`
- `src/lib/db-learning.ts`
- `test/inflight-deadline.test.ts`
- `test/sec-ingest-worker.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-08-18-getaccounts-loop-budget.md`

## Decisions & Trade-offs

- Did not invent a sidecar or bounce Coolify.
- Did not hide the failure with copy.  Run once still fail-closes if the combined budget expires or the broker throws.
- Did not touch strategy pick / #2841 / #2840 / #2812.
- Did not rewrite other long scheduler lanes (`synthetic-stop-monitor` avg 7.2s, `stale-limit-scan` avg 5.9s).  ASC named `ftsMirrorSlice`; that is the ingest pin on this loop.
- FTS ingest will take more ticks (6 vs 20 chunks).  That is the cost of not pinning Manual Run once.

## Verification State

Focused (full suite not re-run):

```bash
npx vitest run test/inflight-deadline.test.ts test/sec-ingest-worker.test.ts test/dashboard-agentic-fallback.test.ts
# Test Files  3 passed (3)
# Tests  43 passed (43)

npx tsc --noEmit   # exit 0
npm run lint       # 0 errors, grandfathered warnings only
```

PR: https://github.com/jaywedgeworth22/Socratic.Trade/pull/2848

## Next Steps & Blockers

- Do not merge or deploy from this seat.
- After merge, confirm Manual Run once no longer fail-closes on a successful ≥6s alpaca-broker read, and that `ftsMirrorSlice` logs stay under the getAccounts first wait.

## Zero-Code Findings

#2845's retry is live (portfolio message format `8000+7000ms` at 22:10:15Z) and still lost.  The 6s first abort matches both live broker latency and the old FTS tick budget on one Node event loop.
