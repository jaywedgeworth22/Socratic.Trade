# 2026-07-11 — Expensive admin-operation abuse/cost controls

PR: <https://github.com/jaywedgeworth22/Socratic.Trade/pull/1409> (ready, not merged)

## Summary

Added one shared admission layer for eight expensive operator actions:

- paid SEC 8-K and 10-K reindexes;
- factor-IC backtest and strategy-tuning dry run;
- Congress score evaluation and manual daily share;
- forced web-source refresh; and
- Robinhood MCP diagnostic probe.

Each operation has a named per-admin sliding-window budget. Over-budget requests return HTTP 429
with `Retry-After`, `code=rate_limited`, and `retryAfterSeconds`; duplicate/conflicting work returns
HTTP 409 with `code=operation_in_flight` and `activeOperation`. A single-flight claim is acquired
before quota debit, so repeated 409 attempts do not consume rate budget. Shared manual admin requests
use process-wide single-flight groups, including one group shared by both paid RAG reindex routes.
Analysis and broker probes use per-admin exclusion because their state is user-scoped. These route-level
claims do not coordinate with scheduler/background entrants; that underlying-boundary convergence is a
separate planned lane and is not overstated as protection here.

## Why

These routes already required admin authorization, but authorization alone did not stop an accidental
double-click, retry loop, or admin script from running concurrent paid provider fan-out, forced TTL
bypasses, broker calls, or long database scans. The guard rejects duplicates before the expensive
callback starts while preserving normal interactive retries and operator ownership of the action.

The rate key is derived only from `resolveRequestUserId(request)`, which consumes the
middleware-established trusted email header and ignores query/body/user-ID hints. The guard is invoked
only after the route's existing `requireAdmin` check. `src/lib/auth/admin.ts` was deliberately not
changed because a separate fail-closed authorization lane owns it.

## Limits and concurrency

| Operation | Budget | Single-flight scope/group |
| --- | ---: | --- |
| `reindex-8k` | 2/hour | all manual admin requests, `rag-reindex` |
| `reindex-10k` | 2/hour | all manual admin requests, `rag-reindex` |
| `backtest-ic` | 10/5 min | per admin |
| `tuning-dry-run` | 6/10 min | shared per-user tuning guard (also `/api/strategy/tune`) |
| `congress-score-eval` | 6/10 min | per admin |
| `congress-share` | 2/hour | all manual admin requests |
| `refresh-websource` | 4/10 min | all manual admin requests |
| `robinhood-probe` | 20/5 min | per admin |

Authorization and explicit validation/config rejection paths happen before quota admission. Empty 10-K
symbol lists, missing Congress credentials, unknown web-source IDs, and a disabled Robinhood adapter do
not debit the operator budget. Routes whose historical contract treats an absent/malformed body as a real
default action (full 8-K reindex, monitored-universe Congress share, or Congress refresh) still enter
admission normally. Only the expensive action is wrapped; cached/status GET handlers on the reindex and
Congress score routes retain their existing behavior.

## Files

- `src/lib/admin-operation-guard.ts` — named budgets, trusted-identity rate keys, explicit 429/409
  responses, and exception-safe single-flight release.
- `src/lib/operation-guard-response.ts` — local stable 429/409 rejection builders aligned with the
  owner-directed shared-package contract.
- `src/lib/tuning-singleflight.ts` — owner-token single-flight shared by public tuning and the admin
  dry run.
- `app/api/strategy/tune/route.ts` — replaces the route-private set with the shared tuning guard.
- `app/api/admin/reindex-8k/route.ts`
- `app/api/admin/reindex-10k/route.ts`
- `app/api/admin/backtest-ic/route.ts`
- `app/api/admin/tuning-dry-run/route.ts`
- `app/api/admin/congress-score-eval/route.ts`
- `app/api/admin/congress-share/route.ts`
- `app/api/admin/refresh-websource/route.ts`
- `app/api/admin/robinhood-probe/route.ts`
- `test/admin-operation-guard.test.ts` — budget, trusted identity, per-admin/manual concurrency,
  duplicate-spam quota preservation, cross-reindex exclusion, and throw/owner-token release coverage.
- `test/admin-operation-route-wiring.test.ts` — all eight routes authenticate before entering the
  correct named guard.
- `test/admin-operation-route-behavior.test.ts` — invoked-handler coverage for auth ordering,
  explicit validation/config rejection without quota debit, 429 provider suppression, and cross-reindex
  409 provider suppression.
- `test/public-auth-rate-limit-hardening.test.ts` — adds same-user, both-direction cross-route
  concurrency coverage for public tuning versus the admin dry run.
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, `docs/ops-observability-security.md`, and this note.

## Verification

- `git diff --check` — passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH node --version` — `v24.18.0`.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/admin-operation-guard.test.ts test/admin-operation-route-wiring.test.ts test/admin-operation-route-behavior.test.ts test/public-auth-rate-limit-hardening.test.ts` — 4 files, 29 tests passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx eslint src/lib/admin-operation-guard.ts src/lib/operation-guard-response.ts src/lib/tuning-singleflight.ts app/api/admin/reindex-8k/route.ts app/api/admin/reindex-10k/route.ts app/api/admin/backtest-ic/route.ts app/api/admin/tuning-dry-run/route.ts app/api/admin/congress-score-eval/route.ts app/api/admin/congress-share/route.ts app/api/admin/refresh-websource/route.ts app/api/admin/robinhood-probe/route.ts app/api/strategy/tune/route.ts test/admin-operation-guard.test.ts test/admin-operation-route-wiring.test.ts test/admin-operation-route-behavior.test.ts test/public-auth-rate-limit-hardening.test.ts` — passed with no output (0 errors/warnings).
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit` — passed.
- Final current-main (`8fca436d`) Node 24 gate:
  - `npm run lint` — 0 errors / 408 grandfathered warnings.
  - `npx tsc --noEmit` — clean.
  - `npm test` — 328 files / 3,629 tests passed.
  - `npm run build` — production build passed with existing middleware/Sentry/cache warnings only.
- The first full gate was also green at prior main (327 files / 3,627 tests), but PR #1398 merged
  externally during that run. Its new main was merged without guard-code overlap and the full ordered
  gate above was repeated before landing.

## Follow-ups / boundaries

- Owner-directed shared-contract follow-up: AG opened green READY
  [`congress-trading-shared` PR #144](https://github.com/jaywedgeworth22/congress-trading-shared/pull/144) for a portable `OperationGuard` rejection
  contract in `congress-trading-shared` (`rate_limited` / `operation_in_flight`, 429/409 status
  mapping, retry/operation metadata). This lane intentionally keeps its local response builder until
  that package has a merged/tagged release; consumer adoption will be a separate commit, not a
  speculative git reference or blocker for these route controls.
- This is process-local state, consistent with the current single-Next-process deployment. A future
  multi-instance topology requires a shared rate-limit/lease backend.
- The single-flight groups coordinate manual admin route calls only. Scheduler/background entrants call
  the underlying share, filing-ingest, and web-refresh functions directly and can still overlap a manual
  request. A planned follow-up must move ownership-aware locking to those shared operation boundaries;
  this lane does not touch the scheduler while its lease work is active elsewhere.
- These are anti-repeat controls, not hard per-request spend ceilings. No request-size or batch-size
  semantics were changed: the 8-K reindex can still request the full dataset, the 10-K route accepts an
  operator-chosen symbol list/limit, and backtest query sizes remain operator inputs. Any default caps
  must stay explicit/adjustable rather than silently truncating a requested backfill.
- Public tuning preserves its legacy 409 compatibility fields (`error=strategy_tuning_in_progress` and
  `message`) while adding the stable `code`, `operation`, and `activeOperation` metadata.
- `app/api/admin/securities/import` is intentionally excluded: it is an external App-A-to-App-B
  bearer-token ingestion contract, not an interactive admin-identity route. Its payload/batch limits
  need sender-contract coordination and should not be keyed to the local admin user. Cheap/status
  reads (`rag-coverage`, connection health, usage, ledgers) and idempotent test emitters were also
  left unchanged.
- No strategy, broker/provider implementation, production configuration, merge, or deployment action
  is included.
