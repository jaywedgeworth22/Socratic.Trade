#!/usr/bin/env bash
# alert-deploy-freshness.selftest.sh - hermetic matrix for the deploy-freshness watchdog.
#
# Builds a throwaway git history + localhost /api/health stub (same pattern as
# verify-deploy-sha.selftest.sh). No production, no Slack, no secrets.
#
# Usage: bash scripts/alert-deploy-freshness.selftest.sh
# Keep this file pure ASCII (AGENTS.md: operator shell scripts, Apple bash 3.2).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNDER_TEST="${SCRIPT_DIR}/alert-deploy-freshness.sh"
[ -f "$UNDER_TEST" ] || { echo "error: ${UNDER_TEST} not found." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "error: python3 is required." >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "error: jq is required." >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/deploy-freshness-selftest.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

cat > "${WORK}/stub.py" <<'PY'
import os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

BODY = os.environ.get("STUB_BODY", "{}").encode()
STATUS = int(os.environ.get("STUB_STATUS", "200"))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(STATUS)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
with open(sys.argv[1], "w") as fh:
    fh.write(str(server.server_port))
server.serve_forever()
PY

REPO="${WORK}/repo"
mkdir -p "$REPO"
git init -q "$REPO"
gitc() { git -C "$REPO" -c user.email=selftest@example.invalid -c user.name=selftest "$@"; }
mkcommit() {
  local msg="$1" date="${2:-}"
  echo "$msg" > "${REPO}/file.txt"
  gitc add file.txt
  if [ -n "$date" ]; then
    GIT_AUTHOR_DATE="$date" GIT_COMMITTER_DATE="$date" gitc commit -q -m "$msg"
  else
    gitc commit -q -m "$msg"
  fi
  gitc rev-parse HEAD
}

# C1 (old) -> C2 (2.5h ago, the first undeployed when live=C1) -> C3 (tip, recent)
# plus D off C1 for divergence.
OLD_DATE="$(python3 -c 'import time; print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()-20000)))')"
MID_DATE="$(python3 -c 'import time; print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()-9000)))')"
C1="$(mkcommit c1 "$OLD_DATE")"
C2="$(mkcommit c2 "$MID_DATE")"
C3="$(mkcommit c3)"
gitc checkout -q -b sidebranch "$C1"
D="$(mkcommit d)"
gitc checkout -q "$C3"

PASSES=0
FAILURES=0

payload() {
  printf '{"ok":true,"checks":{"db":"ok","schedulerAgeSeconds":25,"release":{"sha":%s,"processUptimeSeconds":%s}}}' "$1" "$2"
}

# $1 name, $2 expected exit, $3 expected-ref, $4 stub status, $5 stub body, $6 extra env assignments
run_case() {
  local name="$1" want="$2" expect_ref="$3" status="$4" body="$5"
  shift 5
  local portfile="${WORK}/port"
  rm -f "$portfile"
  STUB_BODY="$body" STUB_STATUS="$status" python3 "${WORK}/stub.py" "$portfile" >/dev/null 2>&1 &
  local pid=$!

  local waited=0
  while [ ! -s "$portfile" ]; do
    waited=$((waited + 1))
    [ "$waited" -gt 100 ] && { echo "FAIL  ${name} (stub never bound)"; FAILURES=$((FAILURES + 1)); kill "$pid" 2>/dev/null; return; }
    sleep 0.1
  done
  local port
  port="$(cat "$portfile")"

  local out code
  # Extra KEY=value args cannot be `"$@" bash` prefixes: bash only treats
  # literal (not expanded) words as assignments. Export them instead.
  out="$(
    export DEPLOY_VERIFY_HOST="http://127.0.0.1:${port}"
    export DEPLOY_VERIFY_NO_FETCH=1
    export DEPLOY_FRESHNESS_NOTIFY=0
    export DEPLOY_FRESHNESS_TREAT_UNREACHABLE=1
    for assign in "$@"; do
      export "$assign"
    done
    cd "$REPO" && bash "$UNDER_TEST" "$expect_ref" 2>&1
  )"
  code=$?
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null

  if [ "$code" = "$want" ]; then
    echo "PASS  ${name} (exit ${code})"
    PASSES=$((PASSES + 1))
  else
    echo "FAIL  ${name} (exit ${code}, wanted ${want})"
    printf '%s\n' "$out" | sed 's/^/      /'
    FAILURES=$((FAILURES + 1))
  fi
}

run_case "live == expected" 0 "$C3" 200 "$(payload "\"${C3}\"" 9000)"
run_case "live AHEAD of expected" 0 "$C1" 200 "$(payload "\"${C3}\"" 9000)"
run_case "in-flight: behind but newest gap is fresh" 0 "$C3" 200 "$(payload "\"${C2}\"" 9000)" \
  DEPLOY_FRESHNESS_STALE_SECONDS=3600
run_case "stale: oldest undeployed is 2.5h old" 3 "$C3" 200 "$(payload "\"${C1}\"" 9000)" \
  DEPLOY_FRESHNESS_STALE_SECONDS=3600
run_case "stale suppressed when threshold is huge" 0 "$C3" 200 "$(payload "\"${C1}\"" 9000)" \
  DEPLOY_FRESHNESS_STALE_SECONDS=864000
run_case "divergent commit" 4 "$D" 200 "$(payload "\"${C3}\"" 10)"
run_case "release sha null" 2 "$C3" 200 "$(payload null 9000)"
run_case "unreachable treated as OK" 0 "$C3" 200 '<html>502 Bad Gateway</html>'
run_case "unreachable fails when opted in" 1 "$C3" 200 '<html>502 Bad Gateway</html>' \
  DEPLOY_FRESHNESS_TREAT_UNREACHABLE=0

echo "---- ${PASSES} passed, ${FAILURES} failed ----"
[ "$FAILURES" = "0" ]
