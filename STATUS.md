# Socratic Trade Status

## Current State
- `app/console/page.tsx` was updated with a single-line flexbox layout for Previous Trades (implemented by earlier agent).
- `app/console/scan/scan-table.tsx` was verified to already implement the requested column settings popover layout, default score sorting, column narrowing, and text alignments.
- OpenRouter telemetry reporting `0 events` was root-caused to the web UI `getLLM()` method falling back to `MockLLM` for OpenRouter due to lack of routing. `src/lib/chat/llm.ts` has been updated to route `CHAT_LLM="openrouter"` properly.
- A bug was fixed in `src/lib/usage-monitor-push.ts` where `userId` was mapped incorrectly in `classifierTelemetryMetadata`.
## 2026-07-25 — Fix vs-SPY benchmark accuracy (CURSOR)

Home vs-SPY was counting all-cash deposits/paper resets as alpha (+31% case) and could mis-read
cash→stock conversions without fills as withdrawals. Flow inference now treats all-cash equity
deltas as transfers, guards missing-fill buys via positionsValue, rebases wiped TWR periods,
reads newest portfolio snapshots, tips the curve with the live portfolio, and refuses synthetic
$100 paper curves. Home/Results show You / SPY decomposition. Branch
`cursor/fix-vs-spy-benchmark-9833`. Rollout: `docs/rollouts/2026-07-25-fix-vs-spy-benchmark.md`.

## 2026-07-24 — Cross-account market scan seed enrichment sharing (ANTIGRAVITY)

## Blockers
- None.

## Next Action
- Run `bash scripts/land.sh` to land the OpenRouter fix branch.
