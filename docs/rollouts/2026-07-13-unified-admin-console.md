# Rollout Note: 2026-07-13 — Unified Admin Console & RAG Chunk Details

## Summary
Comprehensively unified the operator admin panels under a shared responsive sidebar navigation shell (providing a single cohesive app feeling instead of disjointed static sites), redesigned the operator hub `/admin` index to act as a live diagnostic dashboard, and added chunk composition breakdowns to the RAG coverage page to visually expose and break down non-filing chunk data types.

## Why
* **Console Unification**: The user requested that the admin panels cease being individual disjointed sites and instead live under a unified console at `admin.socratictrade.com` (which points to `/admin`).
* **RAG Chunk Transparency**: The user was concerned about the RAG corpus details (why a ticker might have chunks but 0 filings). Displaying the specific chunk types (e.g. SEC, Blended Fundamentals Card, Congressional Disclosure, Insider Transaction, Strategy Coach Memory) directly explains the origin of the RAG data.

## Files Touched
* `src/lib/db-learning.ts` (added `getChunkSourceBreakdown` DB helper)
* `app/api/admin/rag-coverage/route.ts` (updated API response to include global and per-ticker source breakdowns)
* `app/admin/rag-coverage/rag-coverage-client.tsx` (added Corpus Composition card and color-coded source chips for tickers)
* `app/admin/layout.tsx` (implemented desktop sidebar nav / mobile drawer nav shell with sticky header, live clock, and Autonomy Desk return path)
* `app/admin/page.tsx` (redesigned overview index as a real-time metrics and diagnostic dashboard)

## Verification
* **TypeScript Compilation**: `npx tsc --noEmit` passed with zero compiler errors.
* **ESLint**: `npm run lint` passed successfully with zero error exits (warnings only).
* **Test Suite**: `npm test` executed and passed all **3,931 tests** across the application.
* **Production Build**: `npm run build` compiled successfully under Webpack and generated all static routes.

## 2026-07-13 Codex Autofix Round (3 P2 Findings)

### Changes
1. **Surface failed admin probes**: Added `probeErrors` state tracking per endpoint. When a fetch is rejected or returns non-2xx, the error is surfaced on the relevant card (connections health, LLM spend, RAG corpus, server infra, chat transcript) instead of silently falling back to zero/healthy defaults.
2. **Aggregate LLM rows by model**: Aggregates the API response rows by model name client-side before displaying "Cost By Model", so same-model costs from different contexts/accounts are summed. Also fixed `slice(0,3)` before `sort()` (wrong order) and the `costEstUsd` → `costUsd` type mismatch in `LlmSummary`.
3. **Key connection cards by credential lane**: Connection card keys now include `keySource` (e.g. `key={srv.service}:{srv.keySource}`) so React correctly reconciles multi-lane services. The label also shows the key source.

### Files Touched
* `app/admin/page.tsx` (+83 / -25) — all three fixes in the OperatorDashboard component.

### Verification
All four checks passed: `npm run lint` (0 errors), `npx tsc --noEmit` (clean), `npm test` (350 suites / 3,934 tests), `npm run build` (clean).
