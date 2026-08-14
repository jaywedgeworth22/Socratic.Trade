#!/usr/bin/env bash
# Thin wrapper: ship this app's native iOS binary to TestFlight (no Xcode UI).
# Canonical implementation: /Users/jay/apps/ios-fleet/ship-testflight.sh
#
# ios-ship.yml calls THIS file, not the fleet path directly, so the drift guard
# below cannot be bypassed by accident. /Users/jay/apps/ios-fleet is untracked
# shared tooling on the fleet Mac (not a git repo): without the pin check, an
# edit there silently changes what this repo ships -- including apps.json, which
# carries this app's version train.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

bash "${ROOT}/scripts/ios-fleet-pin.sh" --check

exec bash /Users/jay/apps/ios-fleet/ship-testflight.sh socratic --repo-root "$ROOT" "$@"
