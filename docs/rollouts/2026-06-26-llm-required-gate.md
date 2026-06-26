# 2026-06-26 — LLM-required gate: strategy sessions + chat fail loud (no silent rule-based fallback)

Branch `claude/llm-required-gate`.

## Summary
When a user has NO resolvable LLM credential (neither their own per-user key nor the operator
failover), the two LLM-driven actions now ERROR with an actionable message instead of silently
degrading to a rule-based stub:
- **Strategy session** ("Run once" / decide) — `/api/strategy/run` returns 412; deep in
  `proposeTrades` the no-key branch throws `LlmCredentialRequiredError` instead of returning
  `fallbackProposal` (which is deleted).
- **Chat** — `/api/chat` returns 412 (the explicit offline Mock model is still allowed).

Everything else (dashboard, market scan, watchlist/policy/account config, Test-mode sim) keeps
working keyless.

## Why
The silent `fallbackProposal` stub returned a deterministic rule-based "Development Fallback"
proposal that misrepresented LLM research as having run. A strategy session / chat is an
LLM-driven action — failing loud (and telling the user to connect a provider) is correct.

## Files
- `src/lib/llm-required.ts` (new) — `LlmCredentialRequiredError` + the two message constants; pure
  module so it imports safely from both client components and server libs/routes.
- `src/lib/db-api-keys.ts` — `LLM_PROVIDER_SERVICES` + `userHasAnyLlmCredential(userId)` (true when any
  of the six providers resolves a key: the user's own OR the operator failover).
- `src/lib/strategy.ts` — no-key branch throws `LlmCredentialRequiredError`; `fallbackProposal` deleted.
- `src/lib/dashboard.ts` + `app/dashboard-types.ts` — `llmConfigured` flag on the snapshot.
- `app/api/strategy/run/route.ts`, `app/api/chat/route.ts` — 412 pre-check (chat exempts the Mock model).
- `app/dashboard-client.tsx`, `app/ui/assistant-console.tsx` — disable Run once / chat with the message.

## Verification
- `npm ci` → `npx tsc --noEmit` → `npm test` → `npm run build` — all pass (exit 0).
- No orphan references to the deleted `fallbackProposal`. The tests asserting other "not configured"
  behaviors (`red-team`, `p0-safety-fixes`, `strategy-tuning`, `proposal-revalidation`) are unaffected —
  those paths are unchanged.

## Follow-ups
- **Red Team mandatory (separate, NOT in this PR — owner decision pending):** make the Bear/Red-Team a
  hard requirement (drop the Bull-only fallback). Choose between: (a) ANY Red Team failure → hard error /
  no proposal, vs (b) turn only the silent Bull-only generation path into an error while keeping the
  existing high-conviction → human-approval fail-closed. Will also need updating `red-team.test.ts` /
  `p0-safety-fixes.test.ts`.
- Add a focused automated test for the gate (no-LLM → 412 on both routes; `proposeTrades` throws).
