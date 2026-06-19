#!/usr/bin/env bash
# Refresh the standalone PM2 "trading-preview" instance (http://localhost:4100) to a git ref.
#
# Why this exists: the preview runs from its OWN git worktree (~/apps/trading-preview) under
# PM2 — completely independent of whatever worktree the AI tools are editing. That means it is
# never disturbed by an agent's `npm run build` (which wipes that worktree's .next), and a
# running preview is NOT a signal that "an agent is working". Use this to point the preview at
# the latest committed code on demand.
#
# Usage:  scripts/refresh-preview.sh [git-ref]      # default ref: origin/main
set -euo pipefail

REF="${1:-origin/main}"
PREVIEW_DIR="${TRADING_PREVIEW_DIR:-$HOME/apps/trading-preview}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}"

if [ ! -d "$PREVIEW_DIR/.git" ] && [ ! -f "$PREVIEW_DIR/.git" ]; then
  echo "[refresh-preview] $PREVIEW_DIR is not a git worktree. Create it first:"
  echo "  git worktree add --detach \"$PREVIEW_DIR\" origin/main"
  exit 1
fi

cd "$PREVIEW_DIR"
git fetch origin --quiet
BEFORE_LOCK="$(git rev-parse HEAD:package-lock.json 2>/dev/null || true)"
git checkout --detach "$REF" --quiet
AFTER_LOCK="$(git rev-parse HEAD:package-lock.json 2>/dev/null || true)"

if [ "$BEFORE_LOCK" != "$AFTER_LOCK" ]; then
  echo "[refresh-preview] package-lock changed → npm ci"
  npm ci
fi

echo "[refresh-preview] building $(git rev-parse --short HEAD)…"
npm run build
pm2 restart trading-preview --update-env >/dev/null
echo "[refresh-preview] preview now serving $(git rev-parse --short HEAD) on http://localhost:4100"
