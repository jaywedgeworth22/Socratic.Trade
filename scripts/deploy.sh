#!/usr/bin/env bash
# deploy.sh — auto-deploy from the integration worktree
#
# Usage: bash scripts/deploy.sh "commit message"
#
# Runs from the main integration worktree (~/Code/Agentic Trading). It:
#   1. Refuses if there are no changes to commit
#   2. Runs full verification: tsc, npm test, npm run build
#   3. Stages all changes and commits
#   4. Pushes to a cursor/* branch
#   5. Creates a PR with auto-merge enabled
#
# After this, CI runs verify on the PR; once green it auto-merges, and
# deploy.yml fires on the merge to main. No manual steps needed.
#
# Safe to re-run after fixing a test/build failure.

set -euo pipefail

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; BOLD='\033[1m'; RESET='\033[0m'
die()  { echo -e "${RED}[deploy] ERROR: $*${RESET}" >&2; exit 1; }
ok()   { echo -e "${GREEN}[deploy] OK:    $*${RESET}"; }
info() { echo -e "${BOLD}[deploy] $*${RESET}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

COMMIT_MSG="${1:-}"
if [ -z "$COMMIT_MSG" ]; then
  die "Usage: bash scripts/deploy.sh \"commit message\""
fi

# ── 1. Check there are changes ─────────────────────────────────────────────
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  die "No changes to commit — nothing to deploy."
fi

# ── 2. Revert generated files that leak into git ───────────────────────────
git checkout -- next-env.d.ts 2>/dev/null || true

# ── 3. Generate a branch name ──────────────────────────────────────────────
BRANCH="cursor/$(echo "$COMMIT_MSG" | tr '[:upper:] ' '[:lower:]-' | sed 's/[^a-z0-9-]//g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//' | head -c 60)"
info "Branch: $BRANCH"

# ── 4. Verify before commit ────────────────────────────────────────────────
info "Running npx tsc --noEmit ..."
npx tsc --noEmit || die "TypeScript check failed."

info "Running npm test ..."
npm test || die "Tests failed."

info "Running npm run build ..."
npm run build || die "Build failed."
ok "All verification passed."

# ── 5. Commit ──────────────────────────────────────────────────────────────
info "Committing ..."
git add -A
git commit -m "$COMMIT_MSG"
ok "Committed."

# ── 6. Push ─────────────────────────────────────────────────────────────────
info "Pushing to origin/$BRANCH ..."
HOOKS_ALLOW_MAIN_PUSH=1 git push -u origin "HEAD:$BRANCH" || die "Push failed."
ok "Pushed."

# ── 7. Create PR with auto-merge ───────────────────────────────────────────
info "Creating PR ..."
PR_URL=$(gh pr create \
  --title "$COMMIT_MSG" \
  --body "Auto-deployed from the integration worktree." \
  2>&1) || die "PR creation failed: $PR_URL"

# Extract PR number from the URL
PR_NUM=$(echo "$PR_URL" | grep -oE '[0-9]+$')
if [ -z "$PR_NUM" ]; then
  die "Could not parse PR number from: $PR_URL"
fi

info "Enabling auto-merge on PR #$PR_NUM ..."
gh pr merge "$PR_NUM" --squash --auto || die "Auto-merge enable failed."

# ── 8. Return to main ──────────────────────────────────────────────────────
git checkout main
# Discard any generated files that popped back
git checkout -- next-env.d.ts 2>/dev/null || true

echo ""
echo -e "${GREEN}${BOLD}Deployed!${RESET}"
echo "  PR: $PR_URL  (auto-merge enabled — CI will land + deploy automatically)"
echo "  Back on main.  git pull --ff-only when the merge lands."
