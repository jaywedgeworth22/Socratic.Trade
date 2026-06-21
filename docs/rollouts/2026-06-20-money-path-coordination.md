# 2026-06-20 — Money-path plan: fleet coordination & status

Multiple Claude Code sessions (a ~6-session fleet) are working the 14-task money-path
safety plan in this `agent/claude` worktree concurrently. **Direct session-to-session
messaging is unavailable** (the CCD `send_message` / `search_session_transcripts` tools
require interactive approval and are blocked in unsupervised mode), so this committed doc
is the coordination channel — the repo's mandated "coordinate via git" rule.

## Task status (this session's view, 2026-06-20)

| Task | What | Status |
|------|------|--------|
| T1 | side-aware per-symbol notional cap | ✅ DONE `69aa3f5` (on main) |
| T2 | partial-fill reconciliation (idempotent) | ✅ DONE `69aa3f5` (on main) |
| T3 | side-aware FIFO matcher | ✅ DONE `69aa3f5` (on main) |
| T8 | short protective exits (proactive + synthetic) | ✅ DONE `69aa3f5` (on main) |
| T5 | paper-projection side-aware guards | ✅ DONE `9bf7848` (parallel session) |
| T10 | gross/net exposure gates enforced | ✅ DONE `da644b6` (origin/agent/claude) |
| T14-policy | opens-only dailyNotionalUsed; dead helper removed | ✅ DONE `da644b6` |
| T14-db | empty `account_number` normalization | 🟡 IN PROGRESS in `db.ts` (uncommitted edits present) |
| T6 | db notional tests + null-notional fallback | ⬜ `db.ts` / `persistence-notification.test.ts` |
| T9 | `recordFillFromProposal` short/cover tests | ⬜ `performance.test.ts` |
| T11 | red-team fail-open tests | ⬜ `red-team.test.ts` / `reconciliation-risk.test.ts` |
| T12 | tax long-only pin (document + guard tests) | ⬜ `tax.ts` / `tax.test.ts` |
| T13 | daily-reset timezone + kill-switch notification | ⬜ `db.ts` |

## Owner decisions (from the user, 2026-06-20)

- **T14-db: APPROVED.** Normalize a missing/empty `account_number` to an explicit sentinel
  consistently at BOTH write (`INSERT INTO trade_proposals`, db.ts:1255) and read
  (`dailyExecutionStats` db.ts:1021, `notionalInLastMinutes` db.ts:1049). The data-migration
  risk is acceptable — the agentic account holds throwaway-only funds.
- **Short-selling live-safety: relaxed.** The agentic account will only ever hold money the
  owner is willing to lose, so the hard "no short live until full review" gate is not a blocker
  (keep `shortSellingEnabled` default-off in policy regardless).
- **Merge cadence:** land on `agent/claude`; the integration process merges to `main` when the
  worktree settles (`69aa3f5` already on main; `da644b6` to follow).

## Collision-avoidance notes

- `db.ts` is contended (T14-db / T6 / T13 all live there) — **one session should own db.ts edits**.
- `performance.test.ts` (T9), red-team (T11), and tax (T12) are separable, distinct files.
- Always stage commits **explicitly** (never `git add -A`) so concurrent uncommitted work in
  other files is not swept.
