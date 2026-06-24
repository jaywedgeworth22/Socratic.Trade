# 2026-06-24 — Per-account state isolation (PR 1 of 3) — IN PROGRESS

Branch: `claude/per-account-isolation`. Design: `docs/design/per-account-isolation.md`.

## Summary (what's done so far)
Staged PR 1 of the three follow-ons after #122 (safety) and #124 (dead-field
cleanup). Goal: each connected account runs its own isolated state instead of all
of a user's accounts sharing one. Owner decision: **full isolation**, except
shareable-type (fact-tier) learning stays user-wide; `strategy_profiles` becomes a
copyable named **library** and each account has its own **live** state.

Landed on the branch so far (each verified green):
1. **Schema foundation** (`db.ts migrate()`): new `account_strategy_state` table
   (per-account live policy + `system_state`, keyed by `connected_accounts.id`,
   PK `(user_id, connected_account_id)`, no hard FK — deletion handled in code).
   Nullable `connected_account_id` columns + indexes added to `strategy_runs`,
   `skipped_candidate_counterfactuals`, `counterfactual_learning_watermarks`,
   `audit_events`, `notification_events`.
2. **Core policy + system-state isolation** (`db-profiles.ts`):
   `getPolicy(userId, connectedAccountId?)` reads the account's live row (seeded
   lazily from the user-level base on first touch — byte-identical day one);
   `setPolicy`/`setStrategyPrompt`/`create|update|activateStrategyProfile` all
   mirror into the active account's live row so it never goes stale. Activating a
   library strategy copies it into the active account's live state.
   `test/per-account-policy-isolation.test.ts` proves independent policy +
   per-account `systemState` + broker-derived `paperMode`.

## Why
See `docs/design/per-account-isolation.md` §1–3. The library-vs-live split makes
PR 2 (shared strategy library + copy-to-account) a natural follow-on.

## Files (so far)
- `src/lib/db.ts` — schema (new table + tag columns).
- `src/lib/db-profiles.ts` — account-aware getPolicy/setPolicy/getStrategyPrompt/
  setStrategyPrompt + `account_strategy_state` helpers + write-through mirrors.
- `test/per-account-policy-isolation.test.ts` — new.
- `docs/design/per-account-isolation.md`, `STATUS.md`, this note.

## Verification (run)
- `npx tsc --noEmit` — clean.
- `npm test` — 1064/1065 (+3 new; only the pre-existing `cache-provenance` date flake).
- `npm run build` — green.

## Remaining (next slices on this branch, NOT yet done)
- **Run-state / run-lock per account**: `strategy_run_lock:${userId}` →
  `:${connectedAccountId}`; `strategy_runs.connected_account_id` writes;
  `getLastStrategyRunStartedAt` account param.
- **Scheduler**: `userSchedules` keyed by `(userId, accountId)`; per-account cadence
  rehydrate; iterate a user's autonomy-active accounts.
- **Performance-derived learning per account**: write/read
  `skipped_candidate_counterfactuals` + `counterfactual_learning_watermarks` by
  `connected_account_id`. Fact-tier `learned_context` stays user-wide (owner rule).
- **Audit / notification account tagging** (writers pass account; readers gain filter).
- **Deletion purge**: extend `deleteConnectedAccount` + account-deletion to remove
  `account_strategy_state` + per-account learning rows.
- PR stays a **draft** until these land + full trio re-verified.

## Follow-ups / risks
- Dual keying scheme (new state on `connected_account_id`; legacy execution tables on
  `account_number`) is deliberate for now; documented in the design doc §2.
- Separate from this PR: the session's hidden-limits audit (Voyage ingest cadence,
  scan enrichment top-30, Alpaca stream symbol drop) — surfaced to owner, not fixed.
</content>
