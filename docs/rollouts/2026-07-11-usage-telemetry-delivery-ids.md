# Usage telemetry delivery IDs

## Summary

Socratic.Trade now supplies explicit idempotency keys for every usage-monitor delivery. LLM and
RAG events reuse their durable local ledger-row IDs, broker balance metrics share one snapshot ID
with metric suffixes, and each aggregated provider-call lane gets a unique window ID.

## Why

The cross-app fallback key intentionally remains based on source app, provider, metric type,
key reference, and occurrence time. Aggregated credential lanes in one flush share that time and
previously omitted `keyRef`, so distinct lane payloads could collide and one was silently dropped.
Explicit source identity fixes the producer without rekeying the shared compatibility contract.

## Files

- `src/lib/usage-monitor-push.ts`
- `src/lib/llm-usage.ts`
- `src/lib/rag-metering.ts`
- `test/usage-monitor-push.test.ts`
- `docs/usage-monitor-integration.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (live board)

## Verification

- `npm test -- test/usage-monitor-push.test.ts` — 7/7 pass.
- `npx tsc --noEmit` — pass under Node 24.
- Scoped ESLint over the three source files and focused test — pass.
- Full lint/test/build gate — pending before PR handoff.

## Follow-ups

- Land the paired API Usage Monitor hardening first or alongside this producer fix; its ingest
  route now returns 409 for conflicting payloads instead of silently accepting one.
- No merge to Socratic.Trade `main` without an explicit landing decision because merge
  auto-deploys production.
