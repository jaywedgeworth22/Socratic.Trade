#!/usr/bin/env bash
# Codex Cloud maintenance: run on cached container resume after branch checkout.
# Quick health check only — no heavy installs.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Codex Cloud maintenance (resumed container)"

# Verify the Slack token is still valid (lightweight, no side effects)
if [ -n "${SLACK_BOT_TOKEN:-}" ]; then
  bash scripts/slack-sync.sh test 2>/dev/null || echo "Slack coordination: token check failed (may be transient)"
else
  echo "SLACK_BOT_TOKEN not set — Slack coordination silent."
fi

echo "==> Maintenance complete."
