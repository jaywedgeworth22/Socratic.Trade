# 2026-07-04 — Integration worktree folder renamed + Cursor is now a parallel agent (Monet)

## Summary
Two owner-directed changes, on branch `claude/register-monet-lane` (the fleet-infra PR #436):
1. The **main integration worktree moved** from `~/Code/Agentic Trading` to **`~/Code/Socratic.Trade`**.
   Updated every **operational** reference (scripts + current docs). Historical `docs/rollouts/*`
   and `docs/reviews/*` were deliberately left untouched (they record past state; rewriting them
   would falsify the record).
2. **Cursor is now a parallel autonomous agent (model: DeepSeek)**, a peer to Claude/Monet, Codex,
   and Antigravity — no longer the human review cockpit. Updated its role docs.

## What changed — folder rename (operational only)
`Code/Agentic Trading` -> `Code/Socratic.Trade` in:
- **Scripts (functional):** `scripts/land.sh` (`MAIN_INTEGRATION_WORKTREE` + messages),
  `scripts/githooks/pre-push` (`MAIN_INTEGRATION_WORKTREE` guard + messages),
  `scripts/sync-preview-lanes.sh` (`INTEGRATION_DIR` default), `scripts/sync-watchdog.sh`
  (`INTEGRATION_DIR` default), `scripts/setup-agent-previews.sh` (header comments).
  **Critical:** the pre-push "block pushes from the integration worktree" guard and `land.sh`'s
  refuse-to-run-from-main check both do exact-path matching, so these had to move together.
- **Docs (current):** `AGENTS.md` (worktree table + pre-push guard note + Cursor section),
  `docs/deployment.md`, `README.md`, `PLAN.md`, `.cursor/rules/handoff.mdc`, `ci-pending/README.md`.
- The new path has **no space** (was "Agentic Trading"), which removes a shell-escaping hazard.

## What changed — Cursor as a parallel DeepSeek agent
- **`AGENTS.md`** — the `~/apps/trading-cursor` worktree row owner is now "Cursor (DeepSeek,
  parallel agent)"; the `main` row's "(human via Cursor)" is now "(human integrator)"; and the
  "Cursor: the human review cockpit (not a 4th agent lane)" section was rewritten to **"Cursor: a
  parallel agent (model: DeepSeek)"** — own worktree `~/apps/trading-cursor` / `cursor/*` branch /
  port 4103 / `cursor.jays.services`, land via PR, never push to `main`.
- **`.cursor/rules/handoff.mdc`** — the "Your role: the human review cockpit" section rewritten to
  "a parallel autonomous agent (model: DeepSeek)"; title/description brand updated to Socratic Trade.

## Why
Owner: "everything for that app is now in the Socratic.Trade folder — fix EVERYTHING that
references the old folder," and "Cursor is going to be used as a parallel agent now to use DeepSeek."

## Assumptions / verify
- New path inferred as **`~/Code/Socratic.Trade`** (same `~/Code/` parent, folder renamed to the
  stated "Socratic.Trade"). If the actual path differs, the `land.sh` + `pre-push` exact-path
  guards must be corrected to match. **Owner: confirm the exact path.**
- Cursor is documented as a parallel agent but is **not** yet wired into
  `scripts/setup-agent-previews.sh` / `sync-preview-lanes.sh` as a script-managed lane (its 4103
  tunnel ingress already exists and its branch convention is `cursor/*`, not `agent/cursor`). Can
  add it there on request.

## Verification
- `bash -n` clean on all five edited shell scripts.
- `grep 'Code/Agentic'` over the operational file set returns nothing.
- Guards confirmed: `land.sh` + `pre-push` `MAIN_INTEGRATION_WORKTREE="$HOME/Code/Socratic.Trade"`.

## Follow-ups
- Historical `docs/rollouts/*`, `docs/reviews/*`, `STATUS.md` history, and brand-name "Agentic
  Trading" mentions were intentionally left (out of "the old folder" scope).
- If the owner wants Cursor fully script-managed, add it to `setup-agent-previews.sh` (NAMES/PORTS)
  and `sync-preview-lanes.sh` with its `cursor/*` convention.
