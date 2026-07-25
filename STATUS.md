# Socratic Trade Status

## Current State
- `app/console/page.tsx` was updated with a single-line flexbox layout for Previous Trades (implemented by earlier agent).
- `app/console/scan/scan-table.tsx` was verified to already implement the requested column settings popover layout, default score sorting, column narrowing, and text alignments.
- OpenRouter telemetry reporting `0 events` was root-caused to the web UI `getLLM()` method falling back to `MockLLM` for OpenRouter due to lack of routing. `src/lib/chat/llm.ts` has been updated to route `CHAT_LLM="openrouter"` properly.
- A bug was fixed in `src/lib/usage-monitor-push.ts` where `userId` was mapped incorrectly in `classifierTelemetryMetadata`.

## Blockers
- None.

## Next Action
- Run `bash scripts/land.sh` to land the OpenRouter fix branch.
