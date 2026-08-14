#!/usr/bin/env bash
# ios-fleet-pin.sh - verify (or refresh) the checksum pin for the shared iOS
# ship tooling this repo depends on.
#
# Usage:
#   bash scripts/ios-fleet-pin.sh            # verify; exit 1 on drift
#   bash scripts/ios-fleet-pin.sh --check    # same
#   bash scripts/ios-fleet-pin.sh --update   # rewrite the pin from the runtime copy
#
# WHY THIS EXISTS
#   /Users/jay/apps/ios-fleet is NOT a git repo. It is untracked shared tooling
#   that lives only on the fleet Mac, and Socratic.Trade's ios-ship workflow runs
#   it verbatim. A one-character edit there changes what this repo ships, with no
#   history, no review, and no way to answer "which tooling produced this build?"
#   from the repo. apps.json in particular carries this app's version train
#   (marketingVersionDefault), so editing it changes the shipped version number.
#
#   Congress.Trade guards this by vendoring a full copy of the tooling and
#   diffing it. That gets the guarantee at the cost of a second copy per repo
#   that must be updated in lockstep - and its own drift check is red today
#   precisely because two copies exist with no defined reconciliation direction.
#   This repo takes the same guarantee with a checksum instead: refreshing the
#   pin is a reviewed 3-line PR rather than a 50KB re-vendor.
#
# ON DRIFT
#   Read the diff, decide whether the tooling change is wanted, then either fix
#   the tooling or run `--update` and land the new pin in a PR. Emergency bypass
#   for a single ship: IOS_FLEET_PIN_SKIP=1.
#
# ASCII-only (Apple bash 3.2 safe).

set -euo pipefail

FLEET_DIR="${IOS_FLEET_DIR:-/Users/jay/apps/ios-fleet}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIN_FILE="${REPO_ROOT}/scripts/ios-fleet.sha256"

# Exactly the runtime files that can change what this repo ships.
PINNED_FILES="ship-testflight.sh asc-api.mjs apps.json"

MODE="check"
case "${1:-}" in
  --update) MODE="update" ;;
  --check|"") MODE="check" ;;
  *) echo "usage: $0 [--check|--update]" >&2; exit 2 ;;
esac

hash_one() {
  # "<sha256>  <name>" for one file, name-only so the pin is path-independent.
  local f="$1"
  [[ -f "${FLEET_DIR}/${f}" ]] || { echo "error: missing ${FLEET_DIR}/${f}" >&2; return 1; }
  printf '%s  %s\n' "$(/usr/bin/shasum -a 256 "${FLEET_DIR}/${f}" | awk '{print $1}')" "$f"
}

compute_all() {
  local f
  for f in $PINNED_FILES; do
    hash_one "$f" || return 1
  done
}

if [[ "$MODE" == "update" ]]; then
  {
    echo "# sha256 pin for the shared iOS ship tooling in ${FLEET_DIR}."
    echo "# That directory is not a git repo; this file is the repo's record of"
    echo "# exactly which tooling revision is allowed to ship this app."
    echo "# Refresh with: bash scripts/ios-fleet-pin.sh --update  (then land it in a PR)"
    compute_all
  } >"$PIN_FILE"
  echo "[ios-fleet-pin] wrote ${PIN_FILE}"
  exit 0
fi

if [[ -n "${IOS_FLEET_PIN_SKIP:-}" ]]; then
  echo "[ios-fleet-pin] IOS_FLEET_PIN_SKIP set - skipping the drift check for this run"
  exit 0
fi

if [[ ! -f "$PIN_FILE" ]]; then
  echo "error: pin file missing: ${PIN_FILE}" >&2
  echo "       create it with: bash scripts/ios-fleet-pin.sh --update" >&2
  exit 1
fi

EXPECTED="$(grep -v '^#' "$PIN_FILE" | sed '/^$/d')"
ACTUAL="$(compute_all)" || exit 1

if [[ "$EXPECTED" == "$ACTUAL" ]]; then
  echo "[ios-fleet-pin] OK - ${FLEET_DIR} matches scripts/ios-fleet.sha256"
  exit 0
fi

echo "error: the shared iOS ship tooling has drifted from this repo's pin." >&2
echo "  runtime dir: ${FLEET_DIR}  (untracked - no git history there)" >&2
echo "  pin file:    scripts/ios-fleet.sha256" >&2
echo "" >&2
echo "  expected:" >&2
printf '%s\n' "$EXPECTED" | sed 's/^/    /' >&2
echo "  actual:" >&2
printf '%s\n' "$ACTUAL" | sed 's/^/    /' >&2
echo "" >&2
echo "  A peer agent or the owner changed the shared tooling. Review the change," >&2
echo "  then either revert it or accept it with:" >&2
echo "    bash scripts/ios-fleet-pin.sh --update && git commit -am 'chore(ios): refresh ios-fleet pin'" >&2
echo "  Emergency single-ship bypass: IOS_FLEET_PIN_SKIP=1" >&2
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  echo "::error::ios-fleet tooling drifted from scripts/ios-fleet.sha256 - review and refresh the pin"
fi
exit 1
