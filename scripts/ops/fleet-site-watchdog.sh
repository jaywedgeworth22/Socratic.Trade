#!/usr/bin/env bash
# Fleet site watchdog (Hetzner Coolify host) - multi-app, alert-first, deploy-safe.
#
# WHERE THIS RUNS: the Hetzner box (135.181.192.190 / host.jays.services), NOT the Mac.
# systemd unit fleet-watchdog.service is WantedBy=multi-user.target so it starts on server boot.
#
# Apps watched:
#   - socratictrade.com  (local container on this host) -> container restart allowed
#   - congress.trade     (public only; may live elsewhere) -> alert only
#   - usage.jays.services (public only; may live elsewhere) -> alert only
#
# Safety vs the 2026-07-21 reboot storm:
#   - Host reboot OFF by default (ALLOW_HOST_REBOOT=0)
#   - Never escalate while Coolify is building/exporting an image
#   - Never restart Docker daemon (kills all apps + mid-deploy builds)
#   - Liveness != degraded 503 (db ok => treat as serving)
#   - Longer thresholds; cooldown between actions; startup grace
#
# Pure ASCII only (bash 3.x / remote sh traps on non-ASCII next to $VAR).

set -uo pipefail

WEBHOOK_FILE="/root/.secrets/slack-watchdog-webhook"
STATE_DIR="/var/lib/fleet-watchdog"
mkdir -p "$STATE_DIR"

CHECK_INTERVAL=30
STARTUP_GRACE=300
# Per-app: how long confirmed-down before first action / re-notify
TIER1_AFTER=180
# Re-notify interval while still down (no infinite restart thrash)
RENOTIFY_AFTER=900
# Container restart cooldown for local apps
RESTART_COOLDOWN=600
# Host reboot only if explicitly enabled; still very long
ALLOW_HOST_REBOOT=0
TIER_REBOOT_AFTER=3600
REBOOT_COOLDOWN=7200
CMD_TIMEOUT=45

# Apps are checked explicitly at the bottom of the main loop (not via a table), so
# adding a new app means: (1) public URL, (2) optional local URL + container label,
# (3) remediate=1 only when the container actually lives on this host.

service_start_time=$(date +%s)

log() {
  echo "$(date -u +'%Y-%m-%dT%H:%M:%SZ') $*"
}

notify() {
  local msg="$1"
  log "ALERT: $msg"
  if [ -r "$WEBHOOK_FILE" ]; then
    local url
    url=$(cat "$WEBHOOK_FILE")
    # escape quotes for JSON
    local safe
    safe=$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g')
    curl -sf --max-time 10 -X POST -H 'Content-type: application/json' \
      --data "{\"text\":\"[fleet-watchdog] ${safe}\"}" "$url" >/dev/null 2>&1 \
      || log "WARN: slack webhook post failed"
  fi
}

# Liveness: app answers with non-5xx, OR 5xx health payload still has db ok.
# 2xx/3xx/4xx = alive. 000/5xx with failed/missing db = dead.
healthy() {
  local url="$1"
  local timeout="${2:-10}"
  local extra_args="${3:-}"
  local code body
  # shellcheck disable=SC2086
  code=$(curl -s $extra_args -o /tmp/.fwd_body -w '%{http_code}' --max-time "$timeout" "$url" 2>/dev/null) || return 1
  [ -z "$code" ] && return 1
  case "$code" in
    000|5*) : ;;
    *) return 0 ;;
  esac
  body=$(cat /tmp/.fwd_body 2>/dev/null || true)
  if [ -n "$body" ] && echo "$body" | jq -e '.checks.db == "ok"' >/dev/null 2>&1; then
    return 0
  fi
  # Non-JSON 5xx from a static/proxy front is still "dead" for that URL
  return 1
}

coolify_busy() {
  # Active image builds / nixpacks / coolify helper that means a deploy is in flight.
  if docker ps --format '{{.Image}} {{.Names}}' 2>/dev/null | grep -qiE 'nixpacks|buildpack|coollabsio/coolify-helper|coolify-builder'; then
    return 0
  fi
  # docker build / buildx process (do not match this script's argv)
  if ps -eo args= 2>/dev/null | grep -E '(^|/)(docker|buildx)[[:space:]].*build' | grep -vq fleet-site-watchdog; then
    return 0
  fi
  return 1
}

container_for_label() {
  local label="$1"
  [ -z "$label" ] && return 1
  docker ps --filter "label=${label}" --format '{{.Names}}' 2>/dev/null | head -1
}

state_get() {
  local key="$1"
  local f="$STATE_DIR/$key"
  if [ -f "$f" ]; then cat "$f"; else echo 0; fi
}

state_set() {
  local key="$1"
  local val="$2"
  printf '%s' "$val" > "$STATE_DIR/$key"
}

check_app() {
  local name="$1"
  local public_url="$2"
  local local_url="$3"
  local container_label="$4"
  local remediate="$5"
  local now down_since last_action last_notify down_seconds

  now=$(date +%s)
  down_since=$(state_get "${name}.down_since")
  last_action=$(state_get "${name}.last_action")
  last_notify=$(state_get "${name}.last_notify")

  # Public check
  if healthy "$public_url" 12; then
    if [ "$down_since" != "0" ] && [ "$down_since" -ne 0 ] 2>/dev/null; then
      notify "${name}: recovered after $((now - down_since))s public-down"
    fi
    state_set "${name}.down_since" 0
    return 0
  fi

  # Public failed. If we have a local URL, only remediate when local is also down.
  if [ -n "$local_url" ]; then
    # local socratic uses HTTPS with Host header and -k
    if [ "$name" = "socratic" ]; then
      if healthy "$local_url" 8 "-k -H Host: socratictrade.com"; then
        log "${name}: public down but local healthy (CDN/DNS/upstream). No remediating."
        if [ "$last_notify" = "0" ] || [ $((now - last_notify)) -ge "$RENOTIFY_AFTER" ]; then
          notify "${name}: public URL down but local health OK - likely Cloudflare/DNS, not this host"
          state_set "${name}.last_notify" "$now"
        fi
        return 0
      fi
    else
      if healthy "$local_url" 8; then
        log "${name}: public down but local healthy. No remediating."
        return 0
      fi
    fi
  fi

  # Confirmed problem (public down; and local down if we check it)
  if [ "$down_since" = "0" ] || [ "$down_since" -eq 0 ] 2>/dev/null; then
    down_since=$now
    state_set "${name}.down_since" "$now"
    log "${name}: down-streak started"
    notify "${name}: health check failed (public). Watching..."
    state_set "${name}.last_notify" "$now"
  fi

  down_seconds=$((now - down_since))
  log "${name}: confirmed down ${down_seconds}s (remediate=${remediate})"

  # Periodic re-notify
  if [ "$last_notify" = "0" ] || [ $((now - last_notify)) -ge "$RENOTIFY_AFTER" ]; then
    notify "${name}: still down ${down_seconds}s"
    state_set "${name}.last_notify" "$now"
  fi

  # Only local-remediate eligible apps
  if [ "$remediate" != "1" ]; then
    return 0
  fi

  if coolify_busy; then
    log "${name}: Coolify deploy/build active - skipping container restart and any reboot"
    return 0
  fi

  if [ "$down_seconds" -lt "$TIER1_AFTER" ]; then
    return 0
  fi

  if [ "$last_action" != "0" ] && [ $((now - last_action)) -lt "$RESTART_COOLDOWN" ]; then
    return 0
  fi

  # Host reboot path (disabled by default)
  if [ "$ALLOW_HOST_REBOOT" = "1" ] && [ "$down_seconds" -ge "$TIER_REBOOT_AFTER" ]; then
    local last_reboot
    last_reboot=$(state_get "host.last_reboot")
    if [ "$last_reboot" = "0" ] || [ $((now - last_reboot)) -ge "$REBOOT_COOLDOWN" ]; then
      if coolify_busy; then
        notify "${name}: would reboot host but Coolify is busy - blocked"
        return 0
      fi
      notify "CRITICAL: REBOOTING HOST for ${name} down ${down_seconds}s (ALLOW_HOST_REBOOT=1)"
      state_set "host.last_reboot" "$now"
      sleep 2
      timeout "$CMD_TIMEOUT" reboot
      exit 0
    fi
  fi

  # Container restart only
  local c
  c=$(container_for_label "$container_label")
  if [ -z "$c" ]; then
    notify "${name}: down ${down_seconds}s and no container for label ${container_label} - Coolify may need a redeploy. Not rebooting host."
    state_set "${name}.last_action" "$now"
    return 0
  fi

  notify "${name}: restarting container ${c} after ${down_seconds}s confirmed down"
  timeout "$CMD_TIMEOUT" docker restart "$c" || log "WARN: docker restart failed for $c"
  state_set "${name}.last_action" "$now"
}

log "fleet-watchdog started (pid $$), interval=${CHECK_INTERVAL}s, host_reboot=${ALLOW_HOST_REBOOT}"

while true; do
  sleep "$CHECK_INTERVAL"
  now=$(date +%s)
  if [ $((now - service_start_time)) -lt "$STARTUP_GRACE" ]; then
    continue
  fi

  # socratic: local remediate
  check_app "socratic" \
    "https://socratictrade.com/api/health" \
    "https://127.0.0.1/api/health" \
    "coolify.resourceName=socratic-trade-prod" \
    "1"

  # congress / usage: public alert only (no containers on this host today)
  check_app "congress" "https://congress.trade/" "" "" "0"
  check_app "usage" "https://usage.jays.services/" "" "" "0"
done
