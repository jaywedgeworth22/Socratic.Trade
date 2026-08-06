#!/usr/bin/env bash
# Codex Cloud setup: install deps, verify Slack coordination tools are reachable.
# Runs on new containers after repo clone. Network access is always enabled.
# Policy lives in AGENTS.md, not here.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Running project cloud-setup"
bash scripts/cloud-setup.sh

echo ""
echo "==> Verifying Slack coordination access"
if [ -n "${SLACK_BOT_TOKEN:-}" ]; then
  bash scripts/slack-sync.sh test
  echo "Slack coordination: OK"
else
  echo "SLACK_BOT_TOKEN not set — Slack coordination disabled (silent no-op)."
  echo "Set SLACK_BOT_TOKEN, SLACK_AGENT_NAME, and SLACK_TOPIC in Codex Cloud environment variables."
fi

echo ""
echo "==> Codex Cloud setup complete."
echo "    At the start of every turn, run: bash scripts/slack-sync.sh read"
echo "    To post to #agent-sync:       bash scripts/slack-sync.sh post \"[CODEX->FLEET] ...\""
