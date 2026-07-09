#!/usr/bin/env bash
# scripts/merge-shepherd.sh
#
# Drives auto-merge-armed PRs home and reports the state of EVERY open PR, so
# background work can't silently rot into CONFLICTING and be forgotten.
#
# It only *acts* (merge / update-branch / re-run verify) on PRs whose author
# already ARMED auto-merge (i.e. it went through scripts/land.sh). Everything
# else it only *reports* — it never force-merges work nobody opted in to land.
#
# Why this is needed: the handoff protocol makes every PR edit docs/EFFORT-LOG.md
# + STATUS.md, so each merge turns every other open PR CONFLICTING. GitHub's
# native auto-merge can't self-heal that; land.sh arms auto-merge once and never
# comes back. This shepherd is the "come back": union-merge (.gitattributes) makes
# those board conflicts vanish on update-branch, and the shepherd re-syncs stuck
# PRs, re-runs flaky verify once, merges the green ones, and publishes a digest.
#
# Design notes:
# - GitHub reports PR mergeability lazily (often "UNKNOWN"), so we don't trust it;
#   we *attempt* the merge and react to the outcome — the attempt forces the
#   computation and tells us whether it's really a conflict.
# - The only merge gate is the required `verify` check (ruleset: no approvals, not
#   strict, no thread-resolution), so `verify == SUCCESS` is our green signal.
#
# Env:
#   GITHUB_REPOSITORY   owner/repo (default: jaywedgeworth22/Socratic.Trade)
#   SHEPHERD_DRY_RUN=1  report only; attempt nothing
#   GH_TOKEN/GITHUB_TOKEN  auth. A PAT (repo+workflow scope) is preferred so that
#                          update-branch re-triggers verify; the default Actions
#                          GITHUB_TOKEN still merges green PRs + reports.
set -uo pipefail

REPO="${GITHUB_REPOSITORY:-jaywedgeworth22/Socratic.Trade}"
DRY="${SHEPHERD_DRY_RUN:-0}"
ISSUE_TITLE="Merge shepherd status"
TMP="$(mktemp)"; trap 'rm -f "$TMP" "$TMP.md"' EXIT

row() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$TMP"; }   # bucket \t num \t note

echo "[shepherd] scanning open PRs in $REPO (dry=$DRY)"
nums=$(gh pr list -R "$REPO" --state open --limit 80 --json number --jq '.[].number' 2>/dev/null)

for num in $nums; do
  d=$(gh pr view "$num" -R "$REPO" \
        --json title,isDraft,autoMergeRequest,statusCheckRollup,labels,headRefOid 2>/dev/null) || continue
  title=$(jq -r '.title' <<<"$d")
  draft=$(jq -r '.isDraft' <<<"$d")
  armed=$(jq -r '.autoMergeRequest != null' <<<"$d")
  sha=$(jq -r '.headRefOid' <<<"$d")
  # conclusion (SUCCESS/FAILURE) for a finished check; else status (IN_PROGRESS/QUEUED)
  # for a running one; else state (PENDING) for a commit-status; else NONE = no check at all.
  verify=$(jq -r '[.statusCheckRollup[]? | select((.name // .context)=="verify")][0] | (.conclusion // .status // .state // "NONE")' <<<"$d")
  reran=$(jq -r '([.labels[]?.name] | index("shepherd-reran")) != null' <<<"$d")

  if [ "$draft" = "true" ]; then row DRAFT "$num" "$title"; continue; fi
  if [ "$armed" != "true" ]; then row NOT-ARMED "$num" "$title  (verify=$verify — parked / not landed via land.sh)"; continue; fi

  echo "[shepherd] #$num armed  verify=$verify reran=$reran"

  if [ "$DRY" = "1" ]; then
    case "$verify" in
      SUCCESS) row WOULD-MERGE "$num" "$title" ;;
      FAILURE) row FAILING "$num" "$title  (verify failing; reran=$reran)" ;;
      NONE)    row WOULD-SYNC "$num" "$title  (no verify check — would re-sync to re-trigger CI)" ;;
      *)       row WAITING "$num" "$title  (verify=$verify — CI running)" ;;
    esac
    continue
  fi

  if [ "$verify" = "SUCCESS" ]; then
    # Attempt the merge; the attempt itself resolves mergeability.
    if out=$(gh pr merge "$num" -R "$REPO" --squash 2>&1); then
      row MERGED "$num" "$title"
    else
      lc=$(printf '%s' "$out" | tr '[:upper:]' '[:lower:]')
      if printf '%s' "$lc" | grep -Eq 'conflict|not mergeable|not up to date|behind|base branch was modified'; then
        # Behind/conflicting — re-sync. union-merge (.gitattributes) auto-resolves board files.
        if gh pr update-branch "$num" -R "$REPO" >/dev/null 2>&1; then
          row UNSTUCK "$num" "$title  (synced to main; verify re-running)"
        else
          gh pr edit "$num" -R "$REPO" --add-label needs-human-merge >/dev/null 2>&1 || true
          row CONFLICT "$num" "$title  (real conflict — needs a human)"
        fi
      else
        row MERGE-RETRY "$num" "$title  (gh: $(printf '%s' "$out" | head -1 | cut -c1-80))"
      fi
    fi

  elif [ "$verify" = "FAILURE" ] && [ "$reran" != "true" ]; then
    # Flake recovery: re-run failed workflow runs for this head sha, exactly once.
    runids=$(gh api "repos/$REPO/actions/runs?head_sha=$sha" \
               --jq '.workflow_runs[] | select(.conclusion=="failure") | .id' 2>/dev/null)
    for rid in $runids; do gh api -X POST "repos/$REPO/actions/runs/$rid/rerun-failed-jobs" >/dev/null 2>&1 || true; done
    gh pr edit "$num" -R "$REPO" --add-label shepherd-reran >/dev/null 2>&1 || true
    row RE-RAN "$num" "$title  (verify failed — re-ran once for flake)"

  elif [ "$verify" = "FAILURE" ]; then
    row FAILING "$num" "$title  (verify failing after a re-run — needs a human)"

  elif [ "$verify" = "NONE" ]; then
    # No verify check ever ran for this head (conflicting-never-dispatched, or an
    # Actions dispatch hiccup). Re-sync to force a fresh CI run. This is #1166's case.
    if out=$(gh pr update-branch "$num" -R "$REPO" 2>&1); then
      row UNSTUCK "$num" "$title  (no CI had run — re-synced to re-trigger verify)"
    elif printf '%s' "$out" | tr '[:upper:]' '[:lower:]' | grep -Eq 'conflict|not mergeable|cannot be'; then
      gh pr edit "$num" -R "$REPO" --add-label needs-human-merge >/dev/null 2>&1 || true
      row CONFLICT "$num" "$title  (real conflict — needs a human)"
    else
      # "already up to date" but still no check → CI genuinely needs a manual nudge
      row WAITING "$num" "$title  (no verify check + branch up-to-date — CI may need a nudge)"
    fi

  else
    row WAITING "$num" "$title  (verify=$verify — CI still running)"
  fi
done

# ---- build digest (portable awk; no grep -P) ----
cnt() { awk -F'\t' -v b="$1" '$1==b{n++} END{print n+0}' "$TMP" 2>/dev/null; }
list() { awk -F'\t' -v b="$1" '$1==b{print "- #"$2" — "$3}' "$TMP" 2>/dev/null; }
now="$(date -u '+%Y-%m-%d %H:%MZ' 2>/dev/null || echo now)"

{
  echo "_Last run: ${now}. The shepherd acts only on auto-merge-armed PRs; it reports the rest._"
  echo
  echo "| state | count |"
  echo "|---|---|"
  echo "| ✅ merged | $(cnt MERGED) |"
  echo "| 🔁 unstuck (synced to main) | $(cnt UNSTUCK) |"
  echo "| ♻️ re-ran verify (flake) | $(cnt RE-RAN) |"
  echo "| ⛔ real conflict — needs human | $(cnt CONFLICT) |"
  echo "| ❌ verify failing — needs human | $(cnt FAILING) |"
  echo "| 🕗 waiting on CI | $(cnt WAITING) |"
  echo "| 🅿️ auto-merge NOT armed | $(cnt NOT-ARMED) |"
  echo "| ✍️ draft | $(cnt DRAFT) |"
  [ "$DRY" = "1" ] && echo "| _(dry) would merge_ | $(cnt WOULD-MERGE) |"
  [ "$DRY" = "1" ] && echo "| _(dry) would re-sync_ | $(cnt WOULD-SYNC) |"
  for pair in \
    "CONFLICT:⛔ Real conflict — needs a human" \
    "FAILING:❌ Verify failing after a re-run — needs a human" \
    "NOT-ARMED:🅿️ Auto-merge NOT armed (parked, or never landed via land.sh)" \
    "MERGED:✅ Merged this run" \
    "UNSTUCK:🔁 Un-stuck (branch synced; verify re-running)" \
    "RE-RAN:♻️ Verify re-run (flake recovery)" \
    "WAITING:🕗 Waiting on CI"; do
    key="${pair%%:*}"; hdr="${pair#*:}"; body="$(list "$key")"
    [ -n "$body" ] && { echo; echo "### $hdr"; echo "$body"; }
  done
} > "$TMP.md"

cat "$TMP.md"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$TMP.md" >> "$GITHUB_STEP_SUMMARY"

if [ "$DRY" != "1" ]; then
  body="$(cat "$TMP.md")
<sub>Auto-maintained by the merge shepherd (\`scripts/merge-shepherd.sh\`, workflow \`merge-shepherd.yml\`). Overwritten each run.</sub>"
  existing=$(gh issue list -R "$REPO" --state open --search "\"$ISSUE_TITLE\" in:title" \
               --json number,title --jq "[.[] | select(.title==\"$ISSUE_TITLE\")][0].number" 2>/dev/null)
  if [ -n "$existing" ] && [ "$existing" != "null" ]; then
    gh issue edit "$existing" -R "$REPO" --body "$body" >/dev/null 2>&1 && echo "[shepherd] updated tracking issue #$existing"
  else
    gh issue create -R "$REPO" --title "$ISSUE_TITLE" --body "$body" >/dev/null 2>&1 && echo "[shepherd] created tracking issue"
  fi
fi

echo "[shepherd] done"
