#!/usr/bin/env bash
# publish-ios-versions.sh — update the public fleet iOS version manifest.
#
# Called by ship-testflight.sh after a successful upload.  Also safe to run
# by hand.  Never prints secret values.  Failure is non-fatal for ships.
#
# Usage:
#   bash /Users/jay/apps/ios-fleet/publish-ios-versions.sh \
#     --bundle-id trade.socratic.app \
#     --version 1.0.68 \
#     [--build 202608211800] \
#     [--apple-id 6799238379] \
#     [--display-name "Socratic.Trade"]
#
# Writes:
#   /Users/jay/apps/ios-fleet/ios-app-versions.json
#   https://github.com/jaywedgeworth22/ios-app-versions  (versions.json)

set -euo pipefail

FLEET_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_JSON="${FLEET_DIR}/ios-app-versions.json"
REPO="jaywedgeworth22/ios-app-versions"
REMOTE_PATH="versions.json"

BUNDLE_ID=""
VERSION=""
BUILD=""
APPLE_ID=""
DISPLAY_NAME=""

usage() {
  sed -n '1,20p' "$0"
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle-id) BUNDLE_ID="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --build) BUILD="$2"; shift 2 ;;
    --apple-id) APPLE_ID="$2"; shift 2 ;;
    --display-name) DISPLAY_NAME="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$BUNDLE_ID" && -n "$VERSION" ]] || { echo "need --bundle-id and --version" >&2; exit 2; }

python3 - "$LOCAL_JSON" "$BUNDLE_ID" "$VERSION" "$BUILD" "$APPLE_ID" "$DISPLAY_NAME" <<'PY'
import json, sys, datetime
path, bundle, version, build, apple_id, display = sys.argv[1:7]
try:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except FileNotFoundError:
    data = {"schemaVersion": 1, "apps": {}}
apps = data.setdefault("apps", {})
entry = apps.get(bundle, {})
entry["marketingVersion"] = version
if build:
    entry["build"] = build
if apple_id:
    entry["appleId"] = int(apple_id)
if display:
    entry["displayName"] = display
apps[bundle] = entry
data["schemaVersion"] = 1
data["updatedAt"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
with open(path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
print("local-manifest-updated", bundle, version)
PY

if ! command -v gh >/dev/null 2>&1; then
  echo "gh not installed; local manifest only" >&2
  exit 0
fi

CONTENT_B64="$(python3 -c 'import base64,sys; print(base64.b64encode(open(sys.argv[1],"rb").read()).decode())' "$LOCAL_JSON")"
SHA="$(gh api "repos/${REPO}/contents/${REMOTE_PATH}" --jq .sha 2>/dev/null || true)"

ARGS=(
  --method PUT
  "repos/${REPO}/contents/${REMOTE_PATH}"
  -f message="chore: ${BUNDLE_ID} ${VERSION}"
  -f content="${CONTENT_B64}"
)
if [[ -n "$SHA" ]]; then
  ARGS+=(-f sha="$SHA")
fi

if gh api "${ARGS[@]}" >/dev/null; then
  echo "remote-manifest-updated ${REPO}/${REMOTE_PATH}"
else
  echo "remote-manifest-publish-failed" >&2
  exit 1
fi
