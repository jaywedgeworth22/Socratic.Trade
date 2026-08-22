#!/usr/bin/env bash
# Local half of .github/workflows/shared-package-pin-check.yml.
# This repo must pin @jaywedgeworth22/congress-trading-shared to an immutable
# 40-char commit SHA (tags can move). Peer comparison against Congress.Trade
# stays in CI (needs GH_PACKAGES_TOKEN).
set -euo pipefail
cd "$(dirname "$0")/.."

PKG='@jaywedgeworth22/congress-trading-shared'
SPEC="$(python3 -c "import json; print(json.load(open('package.json'))['dependencies']['${PKG}'])")"
REF="${SPEC##*#}"
if ! printf '%s' "$REF" | grep -qE '^[0-9a-fA-F]{40}$'; then
  echo "error: ${PKG} must be a 40-char SHA pin, got: ${SPEC}" >&2
  exit 1
fi

LOCK="$(python3 -c "import json; print(json.load(open('package-lock.json'))['packages']['node_modules/${PKG}']['resolved'])")"
if ! printf '%s' "$LOCK" | grep -qi "$REF"; then
  echo "error: package-lock.json resolved '${LOCK}' does not include package.json SHA ${REF}" >&2
  exit 1
fi

echo "OK: ${PKG} pinned to ${REF}"
echo "OK: lock resolved ${LOCK}"
