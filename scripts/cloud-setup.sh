#!/usr/bin/env bash
# Canonical setup for a fresh, isolated checkout (Claude Code cloud/remote sandbox,
# Codespaces, devcontainer, or any throwaway clone). Idempotent — safe to re-run.
#
# Point your environment's "setup script" field at this file:
#   bash scripts/cloud-setup.sh
#
# The app runs keyless in Test mode (local SQLite at data/app.db). No secrets are
# required to boot. Inject OPENAI_API_KEY only if you want the LLM "Run once" /
# decide loop. NEVER set paperMode: false here.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Node: $(node --version 2>/dev/null || echo 'not found')  npm: $(npm --version 2>/dev/null || echo 'not found')"

# Deterministic install from the committed lockfile.
echo "==> Installing dependencies (npm ci)"
npm ci

# Give the sandbox explicit, safe defaults + a place for injected secrets.
# Non-destructive: never clobber an existing .env.local.
if [ ! -f .env.local ] && [ -f .env.example ]; then
  echo "==> Seeding .env.local from .env.example (Test-mode defaults; keys blank)"
  cp .env.example .env.local
fi

echo "==> Setup complete. Start the app with: npm run dev   (Next.js on :3000)"
echo "    Verify a change with: npx tsc --noEmit && npm test && npm run build"
