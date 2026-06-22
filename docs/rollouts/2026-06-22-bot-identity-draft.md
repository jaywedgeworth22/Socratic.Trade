# 2026-06-22 — Bot identity for agent worktrees (PARKED DRAFT)

## Summary

Drafted the `AGENTS.md` changes needed to run the autonomous agents under a **separate
non-admin GitHub account** (machine user), so a "require 1 approving review" rule on
`main` becomes enforceable (the owner can approve the bot's PRs; GitHub forbids approving
your own). **Docs-only, opened as a draft PR — do NOT merge until the bot account + token
actually exist.**

## Why

The `main-protection` ruleset currently requires `0` approvals because every PR is
authored by the single identity `jaywedgeworth22`. Requiring a review with one identity
would deadlock all merges. A second (bot) identity authoring the agents' PRs removes the
deadlock.

## Changes

- `AGENTS.md` (and `CLAUDE.md` via symlink) — new "Bot identity for agent worktrees
  (PLANNED — not yet active)" subsection under *Git author identity*, covering:
  - bot account = repo **Write** collaborator, not in the ruleset bypass list;
  - **per-worktree identity requires `extensions.worktreeConfig`** (the single shared
    `.git/config` `user.email` can't differ per worktree) — enable it, then
    `git config --worktree user.email …` per worktree (bot email in agent worktrees,
    owner noreply in the integration/live worktrees);
  - `GH_TOKEN=<bot fine-grained PAT>` in each agent's env so `gh` pushes + opens PRs as
    the bot (PAT scoped to `agentic-trading`: Contents R/W, PRs R/W, **Workflows R/W** —
    which also unblocks agents pushing `.github/workflows/`);
  - then set the ruleset's required approvals to 1; owner stays a bypass actor (or the
    bot approves) for the owner's own manual PRs;
  - explicit note that this does **not** fix the `STATUS.md` rebase churn (separate fix:
    merge queue, or stop editing `STATUS.md` in feature PRs).

## Verification

Docs-only; no code touched. Placeholders (`<BOT_USERNAME>`, `<BOT_USER_ID>`) must be
filled in when the account is created.

## Follow-ups (owner)

1. Create the bot GitHub account (new unique email; enable 2FA).
2. Add it to the repo as a **Write** collaborator; keep it out of the ruleset bypass list.
3. Generate its fine-grained PAT (repo-scoped; Contents/PRs/Workflows R/W).
4. Fill the placeholders in `AGENTS.md`, configure the agent worktrees + `GH_TOKEN`.
5. Mark this PR ready + merge; then set required approvals to 1 in `main-protection`.
