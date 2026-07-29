#!/usr/bin/env bash
# Monitor Coolify/Hetzner CI + deploy servers and GitHub self-hosted runners.
#
# Fleet CI is NOT GitHub-hosted Actions. Jobs run on self-hosted systemd runners
# under /opt/actions-runners on the Coolify build server ci-cpx32 (77.42.35.209).
# App deploy reviews / Coolify control plane live on the prod host
# (135.181.192.190 / host.jays.services). Agents should run this often.
#
# Usage:
#   bash scripts/monitor-coolify-runners.sh
#   bash scripts/monitor-coolify-runners.sh --ssh
#   bash scripts/monitor-coolify-runners.sh --json
#   bash scripts/monitor-coolify-runners.sh --ssh --fail-on-warn
#
# Env:
#   GH_TOKEN / GITHUB_TOKEN / GITHUB_MCP_TOKEN  - GitHub API (runners + queued jobs)
#   COOLIFY_API_TOKEN                          - Coolify API (server reachability)
#   COOLIFY_API_BASE                           - default https://host.jays.services/api/v1
#   CI_SSH_HOST                                - default 77.42.35.209
#   CI_SSH_KEY                                 - path to SSH private key for ci-cpx32
#   PROD_SSH_HOST                              - default 135.181.192.190
#   HETZNER_ROOT                               - optional password for prod SSH (sshpass)
#
# Exit codes:
#   0  all checks ok
#   1  critical failure
#   2  warnings only (also with --fail-on-warn)
#
# Pure ASCII only (bash 3.x / remote sh traps on non-ASCII next to $VAR).

set -euo pipefail

COOLIFY_API_BASE="${COOLIFY_API_BASE:-https://host.jays.services/api/v1}"
CI_SSH_HOST="${CI_SSH_HOST:-77.42.35.209}"
PROD_SSH_HOST="${PROD_SSH_HOST:-141.148.182.224}"
CI_SERVER_UUID="${CI_SERVER_UUID:-cantpgkbuwe71n1iqzu4qel6}"
export CI_SERVER_UUID

DO_SSH=0
DO_JSON=0
FAIL_ON_WARN=0
for arg in "$@"; do
  case "$arg" in
    --ssh) DO_SSH=1 ;;
    --json) DO_JSON=1 ;;
    --fail-on-warn) FAIL_ON_WARN=1 ;;
    -h|--help)
      sed -n '2,32p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

gh_token() {
  if [ -n "${GH_TOKEN:-}" ]; then
    printf '%s' "$GH_TOKEN"
  elif [ -n "${GITHUB_MCP_TOKEN:-}" ]; then
    printf '%s' "$GITHUB_MCP_TOKEN"
  elif [ -n "${GITHUB_TOKEN:-}" ]; then
    printf '%s' "$GITHUB_TOKEN"
  else
    printf ''
  fi
}

TOKEN="$(gh_token)"
CRITICAL=0
WARN=0
JSON_LINES=()

emit() {
  local level="$1"
  local msg="$2"
  if [ "$DO_JSON" = 1 ]; then
    JSON_LINES+=("$(printf '{"level":"%s","message":%s}' "$level" "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$msg")")")
  else
    printf '[%s] %s\n' "$level" "$msg"
  fi
  case "$level" in
    CRITICAL) CRITICAL=$((CRITICAL + 1)) ;;
    WARN) WARN=$((WARN + 1)) ;;
  esac
}

ok() { emit "OK" "$1"; }
warn() { emit "WARN" "$1"; }
crit() { emit "CRITICAL" "$1"; }
info() { emit "INFO" "$1"; }

ingest_tagged() {
  # Lines tagged LEVEL::message from helper python/ssh parsers.
  local line level msg
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    case "$line" in
      CRITICAL::*) crit "${line#CRITICAL::}" ;;
      WARN::*) warn "${line#WARN::}" ;;
      OK::*) ok "${line#OK::}" ;;
      INFO::*) info "${line#INFO::}" ;;
      *) ok "$line" ;;
    esac
  done
}

check_coolify() {
  if [ -z "${COOLIFY_API_TOKEN:-}" ]; then
    warn "COOLIFY_API_TOKEN unset — skipping Coolify server reachability"
    return 0
  fi
  local code
  code="$(curl -sS -o /tmp/coolify-servers.json -w '%{http_code}' \
    -H "Authorization: Bearer ${COOLIFY_API_TOKEN}" \
    "${COOLIFY_API_BASE}/servers" 2>/dev/null || echo 000)"
  if [ "$code" != "200" ]; then
    crit "Coolify /servers HTTP ${code}"
    return 0
  fi
  python3 - <<'PY' | ingest_tagged
import json, os
data = json.load(open("/tmp/coolify-servers.json"))
ci_uuid = os.environ.get("CI_SERVER_UUID", "cantpgkbuwe71n1iqzu4qel6")
found = {}
for s in data:
    name = s.get("name") or ""
    uuid = s.get("uuid") or ""
    ip = s.get("ip") or ""
    settings = s.get("settings") or {}
    reachable = settings.get("is_reachable")
    usable = settings.get("is_usable")
    unreachable = int(s.get("unreachable_count") or 0)
    is_host = bool(s.get("is_coolify_host"))
    role = "unknown"
    if uuid == ci_uuid or name == "ci-cpx32" or ip == "77.42.35.209":
        role = "ci"
    elif is_host or ip in ("135.181.192.190", "141.148.182.224") or "hel1-2" in name:
        role = "prod"
    found[role] = True
    line = (
        f"Coolify server {name} ({ip}) role={role} "
        f"reachable={reachable} usable={usable} unreachable_count={unreachable}"
    )
    if role in ("ci", "prod") and (reachable is False or usable is False):
        print(f"CRITICAL::{line}")
    elif role in ("ci", "prod") and unreachable > 0:
        print(f"WARN::{line}")
    else:
        print(f"OK::{line}")
if "ci" not in found:
    print("CRITICAL::Coolify CI server ci-cpx32 not found in /servers")
if "prod" not in found:
    print("WARN::Coolify prod/host server not found in /servers")
PY
}

EXPECTED_REPOS=(
  "jaywedgeworth22/Socratic.Trade:socratic-ci"
  "jaywedgeworth22/Congress.Trade:congress-ci"
  "jaywedgeworth22/congress-trading-shared:shared-ci"
  "jaywedgeworth22/Usage-Monitor:usage-ci"
)

check_github_runners() {
  if [ -z "$TOKEN" ]; then
    warn "No GH token — skipping GitHub runner inventory"
    return 0
  fi
  local entry repo label code
  for entry in "${EXPECTED_REPOS[@]}"; do
    repo="${entry%%:*}"
    label="${entry##*:}"
    code="$(curl -sS -o /tmp/gh-runners.json -w '%{http_code}' \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${repo}/actions/runners" 2>/dev/null || echo 000)"
    if [ "$code" != "200" ]; then
      crit "GitHub runners API ${repo} HTTP ${code}"
      continue
    fi
    python3 - "$repo" "$label" <<'PY' | ingest_tagged
import json, sys
repo, need = sys.argv[1], sys.argv[2]
runners = json.load(open("/tmp/gh-runners.json")).get("runners") or []
online_with = []
for r in runners:
    labels = [x.get("name") for x in (r.get("labels") or [])]
    status = r.get("status")
    busy = r.get("busy")
    name = r.get("name")
    line = f"{repo} runner {name} status={status} busy={busy} labels={','.join(labels)}"
    if need in labels and status == "online":
        online_with.append(name)
    if status != "online":
        print(f"CRITICAL::{line}")
    else:
        print(f"OK::{line}")
if not online_with:
    print(f"CRITICAL::{repo} has no online runner with label {need}")
PY
  done

  code="$(curl -sS -o /tmp/gh-queued.json -w '%{http_code}' \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/actions/runs?status=queued&per_page=50" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ]; then
    python3 - <<'PY' | ingest_tagged
import json
runs = json.load(open("/tmp/gh-queued.json")).get("workflow_runs") or []
n = len(runs)
if n == 0:
    print("OK::Socratic.Trade queued Actions runs: 0")
else:
    print(f"WARN::Socratic.Trade has {n} queued Actions run(s) — inspect for missing runner labels")
    for r in runs[:15]:
        print(
            f"INFO::queued {r.get('name')} id={r.get('id')} "
            f"created={r.get('created_at')} {r.get('html_url')}"
        )
PY
  fi
}

ssh_ci() {
  local cmd="$1"
  local key="${CI_SSH_KEY:-}"
  if [ -z "$key" ]; then
    for cand in /tmp/ci_ed25519 /tmp/id_ed25519_mac_jay "$HOME/.ssh/id_ed25519"; do
      if [ -f "$cand" ]; then key="$cand"; break; fi
    done
  fi
  if [ -z "$key" ] || [ ! -f "$key" ]; then
    echo "WARN::CI_SSH_KEY not found — skipping ci-cpx32 SSH checks"
    return 0
  fi
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=12 -i "$key" "root@${CI_SSH_HOST}" "$cmd"
}

ssh_prod() {
  local cmd="$1"
  if [ -n "${HETZNER_ROOT:-}" ] && command -v sshpass >/dev/null 2>&1; then
    sshpass -p "$HETZNER_ROOT" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=12 \
      "root@${PROD_SSH_HOST}" "$cmd"
    return $?
  fi
  local key="${PROD_SSH_KEY:-${CI_SSH_KEY:-}}"
  if [ -n "$key" ] && [ -f "$key" ]; then
    ssh -o StrictHostKeyChecking=no -o ConnectTimeout=12 -i "$key" "root@${PROD_SSH_HOST}" "$cmd"
    return $?
  fi
  echo "WARN::No prod SSH credentials — skipping prod host checks"
  return 0
}

check_ssh() {
  if [ "$DO_SSH" != 1 ]; then
    ok "SSH host checks skipped (pass --ssh to enable)"
    return 0
  fi

  local out rc=0 line pct
  set +e
  out="$(ssh_ci 'set -e
hostname
df -P / | tail -1
free -m | awk "/^Mem:/{printf \"mem_used_mb=%s mem_total_mb=%s\\n\", \$3, \$2}"
echo "running_units=$(systemctl list-units "actions.runner*" --no-legend --state=running | wc -l)"
echo "failed_units=$(systemctl list-units "actions.runner*" --no-legend --state=failed | wc -l)"
for u in /etc/systemd/system/actions.runner*.service; do
  [ -f "$u" ] || continue
  b=$(basename "$u")
  printf "unit %s %s\n" "$b" "$(systemctl is-active "$b")"
done
echo "runner_dirs=$(ls /opt/actions-runners 2>/dev/null | tr "\n" " ")"
' 2>&1)"
  rc=$?
  set -e
  if echo "$out" | grep -q '^WARN::'; then
    printf '%s\n' "$out" | ingest_tagged
  elif [ "$rc" -ne 0 ]; then
    crit "ci-cpx32 SSH failed: $out"
  else
    ok "ci-cpx32 SSH ok"
    while IFS= read -r line; do
      case "$line" in
        unit\ *\ active) ok "ci-cpx32: $line" ;;
        unit\ *) crit "ci-cpx32 unit not active: $line" ;;
        failed_units=0) ok "ci-cpx32: $line" ;;
        failed_units=*) crit "ci-cpx32: $line" ;;
        *) ok "ci-cpx32: $line" ;;
      esac
    done <<< "$out"
    pct="$(echo "$out" | awk '/\/dev\//{print $5}' | tr -d '%' | head -1)"
    if [ -n "${pct:-}" ] && [ "$pct" -ge 90 ] 2>/dev/null; then
      crit "ci-cpx32 disk ${pct}% full"
    elif [ -n "${pct:-}" ] && [ "$pct" -ge 80 ] 2>/dev/null; then
      warn "ci-cpx32 disk ${pct}% used"
    fi
    if echo "$out" | grep -q 'socratic-deploy'; then
      ok "ci-cpx32 has socratic-deploy runner present"
    else
      warn "ci-cpx32 has no socratic-deploy runner - do not target label socratic-deploy"
    fi
  fi

  set +e
  out="$(ssh_prod 'hostname
df -P / | tail -1
echo "containers=$(docker ps --format "{{.Names}}" 2>/dev/null | tr "\n" " ")"
echo "fleet_watchdog=$(systemctl is-active fleet-watchdog.service 2>/dev/null || echo absent)"
if [ -d /opt/actions-runners ]; then echo "actions_runners_dir=present"; else echo "actions_runners_dir=absent"; fi
' 2>&1)"
  rc=$?
  set -e
  if echo "$out" | grep -q '^WARN::'; then
    printf '%s\n' "$out" | ingest_tagged
  elif [ "$rc" -ne 0 ]; then
    warn "prod host SSH failed: $out"
  else
    ok "prod host SSH ok"
    while IFS= read -r line; do
      ok "prod: $line"
    done <<< "$out"
  fi
}

check_workflow_labels() {
  local root
  root="$(cd "$(dirname "$0")/.." && pwd)"
  if ! command -v rg >/dev/null 2>&1; then
    warn "rg not installed — skipping workflow label grep"
    return 0
  fi
  local hits
  hits="$(rg -n 'runs-on:\s*ubuntu-latest|runs-on:\s*\[[^\]]*(socratic-deploy|trading-live)' \
    "$root/.github/workflows" 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    crit "Workflows still target hosted or dead runner labels:"
    echo "$hits" | while IFS= read -r h; do
      [ -n "$h" ] && crit "  $h"
    done
  else
    ok "Workflows: no ubuntu-latest / socratic-deploy / trading-live runs-on matches"
  fi
}

main() {
  info "Coolify/Hetzner runner monitor — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  check_coolify
  check_github_runners
  check_workflow_labels
  check_ssh

  if [ "$DO_JSON" = 1 ]; then
    printf '['
    local i=0
    for line in "${JSON_LINES[@]+"${JSON_LINES[@]}"}"; do
      [ "$i" -gt 0 ] && printf ','
      printf '%s' "$line"
      i=$((i + 1))
    done
    printf ']\n'
  fi

  echo
  echo "Summary: critical=${CRITICAL} warn=${WARN}"
  if [ "$CRITICAL" -gt 0 ]; then
    exit 1
  fi
  if [ "$WARN" -gt 0 ]; then
    exit 2
  fi
  exit 0
}

main
