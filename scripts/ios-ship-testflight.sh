#!/usr/bin/env bash
# Thin wrapper: ship this app's native iOS binary to TestFlight (no Xcode UI).
# Canonical implementation: /Users/jay/apps/ios-fleet/ship-testflight.sh
#
# Owner 2026-08-11: force stable Xcode.app (never Xcode-beta) for ASC/TestFlight.
set -euo pipefail
if [[ -z "${DEVELOPER_DIR:-}" || "$DEVELOPER_DIR" == *Xcode-beta* ]]; then
  if [[ -d /Applications/Xcode.app/Contents/Developer ]]; then
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  fi
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec bash /Users/jay/apps/ios-fleet/ship-testflight.sh socratic --repo-root "$ROOT" "$@"
