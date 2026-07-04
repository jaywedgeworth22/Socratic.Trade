# 2026-07-03 - Console polish and RAG usage safeguards

## Summary

Expanded the active Codex console-polish branch to cover RAG architecture and quota correctness:
Pinecone/Voyage remain the recommended default stack, app-recorded RAG usage is labeled honestly,
Pinecone queries/upserts now record unit-style usage, usage-monitor export sends Pinecone volume as
credits rather than token/row counts, and `storeContexts` has a daily Pinecone Write Unit fuse before
Voyage embedding.

## Why

The owner observed that Pinecone's provider quota was exhausted while the app's RAG dashboard looked
nearly empty. The local ledger was being treated like provider truth even though it only records calls
made through this app after metering was added. The app needs to prevent fresh Pinecone quota from being
burned by repeated writes and must show that provider totals and app-recorded totals are different
views.

## Decisions

- Keep **Voyage finance embeddings + Pinecone + Voyage rerank** as the production default unless a
  corpus benchmark proves a better option.
- Do not add LangChain/LlamaIndex as a core runtime dependency just to follow tutorial convention.
- Use Pinecone/Voyage direct SDK paths and focus on idempotency, provenance, point-in-time filters,
  dedup, and quota fuses.
- Treat LLM earnings summaries as derived event briefs only. Raw earnings sources and structured facts
  stay the source of truth.

## Files

- `src/lib/vector-db.ts`
- `src/lib/rag-metering.ts`
- `src/lib/usage-monitor-push.ts`
- `app/api/admin/rag-coverage/route.ts`
- `app/admin/rag-coverage/rag-coverage-client.tsx`
- `docs/prod-config-voyage.md`
- `docs/reviews/2026-07-03-rag-stack-options.md`
- `docs/design/earnings-rag.md`
- `test/rag-metering.test.ts`
- `test/vector-db-backlog-c-integration.test.ts`
- `test/usage-monitor-push.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`

## Verification

- `npx tsc --noEmit --pretty false`
- `npx vitest run test/rag-metering.test.ts test/vector-db-backlog-c-integration.test.ts`
- `npx vitest run test/rag-metering.test.ts test/vector-db-backlog-c-integration.test.ts test/usage-monitor-push.test.ts`
- `npx vitest run test/dashboard-ui.test.ts test/query-embedding-cache.test.ts test/vector-db.test.ts`
- `npm run lint`
- `npx tsc --noEmit`
- `npm test`
- `npm run build`
- `git diff --check`
- `pm2 restart trading-codex --update-env`

All focused checks and the full required gate pass locally. `npm run lint` reports the existing warning
backlog but exits with zero errors.

## Follow-ups

- Add an earnings producer (`sec-earnings.ts` or equivalent) that writes raw earnings-release,
  transcript, slide, and Q&A chunks plus a structured event sidecar.
- If provider monthly usage APIs become available for Voyage or Pinecone, add those as a separate
  provider-reported row beside the app-recorded ledger.
- Consider a manual import from Pinecone/Voyage console CSVs if the provider dashboards remain UI-only.
