#!/usr/bin/env bash
# Idempotently set up the per-agent LIVE-preview worktrees + PM2 dev servers.
#
# Each AI agent edits in its OWN git worktree (its own branch, .next, data, .env.local) and
# previews its LIVE in-progress edits on its own port via a PM2-managed `next dev` (HMR):
#   Claude      → ~/apps/trading-claude       (branch agent/claude)      http://localhost:4100
#   Codex       → ~/apps/trading-codex        (branch agent/codex)       http://localhost:4101
#   Antigravity → ~/apps/trading-antigravity  (branch agent/antigravity) http://localhost:4102
#
# This worktree (~/Code/Agentic Trading, branch `main`) is the INTEGRATION
# checkout — merge agent branches here; do not run an agent dev server in it.
# Production is separate and unaffected: ~/apps/trading-live (pm2 `trading`, `next start` :4000).
#
# Safe to re-run: existing worktrees/PM2 apps are reused/restarted, not duplicated.
set -euo pipefail
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
APPS="${TRADING_APPS_DIR:-$HOME/apps}"
NAMES=(claude codex antigravity)
PORTS=(4100 4101 4102)

git -C "$REPO" fetch origin --quiet || true

for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"; port="${PORTS[$i]}"; dir="$APPS/trading-$name"; branch="agent/$name"; app="trading-$name"

  if [ ! -e "$dir/.git" ]; then
    if git -C "$REPO" show-ref --verify --quiet "refs/heads/$branch"; then
      git -C "$REPO" worktree add "$dir" "$branch"
    else
      git -C "$REPO" worktree add -b "$branch" "$dir" origin/main
    fi
  fi

  if [ ! -e "$dir/node_modules" ]; then
    cp -cR "$REPO/node_modules" "$dir/node_modules" 2>/dev/null || cp -R "$REPO/node_modules" "$dir/node_modules"
  fi
  if [ ! -e "$dir/.env.local" ] && [ -e "$REPO/.env.local" ]; then
    cp "$REPO/.env.local" "$dir/.env.local"
  fi

  # Install git hooks in the agent worktree (idempotent).
  # core.hooksPath is per-clone/worktree, so it must be set in each one.
  # The hook path is relative to the worktree root so it works wherever the
  # worktree is checked out.
  git -C "$dir" config core.hooksPath scripts/githooks
  echo "[setup] $app → git hooks installed (scripts/githooks)"

  if pm2 describe "$app" >/dev/null 2>&1; then
    pm2 restart "$app" >/dev/null
  else
    pm2 start "$dir/node_modules/next/dist/bin/next" --name "$app" --cwd "$dir" -- dev -p "$port" >/dev/null
  fi
  echo "[setup] $app → http://localhost:$port   ($dir on $branch)"
done

# Also install hooks in the main integration worktree (REPO itself).
# The pre-push hook will still block agent-style pushes to main from here,
# but allows the human integrator to override via HOOKS_ALLOW_MAIN_PUSH=1.
git -C "$REPO" config core.hooksPath scripts/githooks
echo "[setup] integration worktree → git hooks installed (scripts/githooks)"

pm2 save >/dev/null
echo "[setup] done. Production stays on :4000 (pm2 'trading'). Integration worktree: $REPO (main)."
