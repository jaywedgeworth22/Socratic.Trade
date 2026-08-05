# 2026-08-05 — Activity-audit leftovers (P2.4 + P3 verification)

## Context & Objective

Close out the activity-feed audit leftovers claim (`grok/activity-audit-leftovers`): verify which §1.4 / §1 P3 items from `docs/reviews/2026-07-09-activity-feed-audit.md` already landed on `main`, mark the effort board accurately, and land only tiny residual polish that does not fight sibling agents on `strategy.ts` / `db-fills`.

## Changes Made

### Verification findings (already on main)

| Item | Status | Evidence on `main` |
|------|--------|--------------------|
| **P2.4** congress_share retry storm (code) | **COMPLETED + DEPLOYED** via **PR #1492** (2026-07-13) | `activeDailySharePromise` single-flight; `isCongressDailyShareDue` 60m `congress_share_last_failure_ms` backoff in `src/lib/congress-share.ts`. OPS CF whitelist for old Hetzner IP is historical (prod on Oracle). |
| **P2 backlog** §1.5–1.9 | **COMPLETED + DEPLOYED** | P2.5 #1451; P2.6 #2459/#1319; P2.7+P2.8 **#2489** / #1320/#1321; P2.9 already on main (#1322 closed; seeding still #1324). |
| **P3.1** feed-storm coalesce | **On main** | `buildUnifiedFeed` consecutive-group coalesce in `src/lib/dashboard-feed.ts`. |
| **P3.2** AAPL trim cap-vs-floor | **On main** | Bump-to-floor / dollar-sell path via **#1297** (`broker-minimum-guard.ts`). |
| **P3.3** `policy_change` attribution | **On main** | `setPolicy` / `setStrategyPrompt` pass `account.id` in `src/lib/db-profiles.ts`. |
| **P3.4** broker-protective-stops attribution | **Mostly on main** | Nearly all `audit()` sites already pass `policy.connectedAccountId`; leftover `bracket_sibling_*` fixed this pass. |
| **P3.6** storage_warning mislabel | **On main** | `storage_warning` in `types.ts` + notify/audit path in `db-health.ts`. |
| **P3.7** KNOWN_GLOBAL footer | **On main** | `KNOWN_GLOBAL_AUDIT_KINDS` → "System-wide" in `dashboard-feed.ts`. |

### Residual (sibling agents — do not touch here)

| Item | Notes |
|------|--------|
| **P3.5** stuck `'undefined'` `fill_events` → `unreconcilable` | One-time audited flip; lives in fill persistence (`db-fills`). Sibling-owned. |
| **P3.8** `evidence_age_anomaly` first-sight per `(id, assertedAt)` | LRU exists in `strategy.ts` but key is currently `userId:account:id` only (no `assertedAt`). Sibling-owned; leave `strategy.ts` alone on this branch. |
| **#1324** owner decisions (4) | Stay **PLANNED / needs owner** (test-local autonomy, RAG 10-K pacing, `llmFallbackModels` seed vs UI, learned_context isolation). |

### Code polish this branch

- `src/lib/broker-protective-stops.ts` — optional `connectedAccountId` on `reconcilePendingBracketTeardowns`; threaded into `bracket_sibling_legs_torn_down` / `bracket_sibling_teardown_abandoned`.
- `src/lib/synthetic-stops.ts` — pass `policy.connectedAccountId` into that reconcile call.
- `test/congress-share.test.ts` — unit coverage for the 60-minute failure backoff on `isCongressDailyShareDue`.

### Docs / board

- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md` — P2.4, P2 backlog, P3 1–4/6–7 marked done; leftovers claim completed; #1324 kept Planned.
- This rollout note.

## Decisions & Trade-offs

- Did **not** implement P3.5 or P3.8 here: owner instruction to leave `strategy.ts` and `db-fills` to sibling agents.
- Did **not** push/PR this commit (owner: commit only).
- OPS half of original P2.4 (CF whitelist of Hetzner `135.181…`) is obsolete after Oracle migration; code half is the durable fix.

## Verification State

```bash
# focused (this polish)
npx vitest run test/congress-share.test.ts -t "isCongressDailyShareDue"
# optional broader
npx vitest run test/congress-share.test.ts test/broker-protective-stops.test.ts
```

Board/doc edits only for the bulk of the claim; code delta is two audit args + one unit test.

## Next Steps & Blockers

1. Sibling agents: P3.5 fill flip + P3.8 evidence_age `(id, assertedAt)` key (or confirm already landed and close issues).
2. Owner: decide #1324 items when ready.
3. Land this branch later via `bash scripts/land.sh` when ready for PR (not done in this pass).

## Zero-Code Findings

Most of the "leftovers" claim was **already shipped** on `main`; the primary work was accurate board hygiene so parallel agents stop re-implementing closed audit items.
