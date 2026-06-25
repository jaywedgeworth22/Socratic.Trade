#!/usr/bin/env bash
# One-time production cutover to Infisical — RUN THIS ON THE PRODUCTION BOX.
#
# This performs the host-side steps an agent cannot do remotely (it needs your
# Infisical machine-identity token and reads your live secret values, which never
# leave the box). It is idempotent and safe to re-run.
#
# It does:
#   2) writes the bootstrap to ~/.config/agentic-trading/deploy.env (chmod 600) so
#      both deploy.yml and the PM2 process can reach Infisical:
#        INFISICAL_TOKEN, INFISICAL_PROJECT_ID, INFISICAL_ENV, REQUIRE_SECRETS_MANAGER=1
#      and imports the current .env.local secrets into the Infisical prod env
#      (excluding the bootstrap vars themselves).
#   3) re-creates the PM2 `trading` process to launch via `npm run start:secrets`,
#      verifies it boots (with REQUIRE_SECRETS_MANAGER=1 a plain start would refuse),
#      and — only with --scrub — backs up and trims .env.local to just the bootstrap.
#
# Usage:
#   INFISICAL_TOKEN='<machine-identity universal-auth token>' \
#     bash scripts/infisical-prod-cutover.sh [--scrub] [--no-restart] [--dir DIR] [--app NAME]
#
# The token is read from the INFISICAL_TOKEN env var (preferred) or an existing
# deploy.env. It is never printed and never committed.
set -euo pipefail

DIR="${DEPLOY_DIR:-$HOME/apps/trading-live}"
APP="${PM2_APP:-trading}"
ENV_DIR="$HOME/.config/agentic-trading"
ENV_FILE="$ENV_DIR/deploy.env"
PROJECT_ID="${INFISICAL_PROJECT_ID:-39d93bb7-76f9-498c-8b50-a7def52e072f}" # agentic-trading
ENV_NAME="${INFISICAL_ENV:-prod}"
SECRETS_PATH="${INFISICAL_PATH:-/}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4000/api/health}"
DO_SCRUB=0
DO_RESTART=1

while [ $# -gt 0 ]; do
  case "$1" in
    --scrub) DO_SCRUB=1 ;;
    --no-restart) DO_RESTART=0 ;;
    --dir) DIR="$2"; shift ;;
    --app) APP="$2"; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '\n[cutover] %s\n' "$*"; }
die() { printf '\n[cutover] ERROR: %s\n' "$*" >&2; exit 1; }

# ── Preconditions ─────────────────────────────────────────────────────────────
command -v infisical >/dev/null 2>&1 || die "Infisical CLI not found. Install it: brew install infisical/get-cli/infisical (or npm i -g @infisical/cli)"
command -v pm2 >/dev/null 2>&1 || die "pm2 not found on PATH."
[ -d "$DIR" ] || die "Deploy dir not found: $DIR (pass --dir)."

# Token: prefer the env var; otherwise reuse one already in deploy.env.
if [ -z "${INFISICAL_TOKEN:-}" ] && [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  INFISICAL_TOKEN="$(. "$ENV_FILE"; printf '%s' "${INFISICAL_TOKEN:-}")"
fi
[ -n "${INFISICAL_TOKEN:-}" ] || die "Set INFISICAL_TOKEN to your machine-identity universal-auth token and re-run."
export INFISICAL_TOKEN INFISICAL_DISABLE_UPDATE_CHECK=true

# Verify the identity can actually read the project before changing anything.
log "Verifying Infisical access (project $PROJECT_ID, env $ENV_NAME)…"
infisical secrets --projectId "$PROJECT_ID" --env "$ENV_NAME" --path "$SECRETS_PATH" >/dev/null \
  || die "Infisical could not read project $PROJECT_ID/$ENV_NAME with this token. Check the machine identity's project access."
log "Infisical access OK."

# ── (2) Persist the bootstrap (chmod 600; never committed) ────────────────────
log "Writing bootstrap to $ENV_FILE"
mkdir -p "$ENV_DIR"; chmod 700 "$ENV_DIR"
umask 177
cat > "$ENV_FILE" <<EOF
# Infisical bootstrap for the agentic-trading production box. Machine-managed by
# scripts/infisical-prod-cutover.sh. chmod 600. NEVER commit this file.
export INFISICAL_TOKEN='$INFISICAL_TOKEN'
export INFISICAL_PROJECT_ID='$PROJECT_ID'
export INFISICAL_ENV='$ENV_NAME'
export INFISICAL_PATH='$SECRETS_PATH'
export REQUIRE_SECRETS_MANAGER=1
EOF
umask 022
chmod 600 "$ENV_FILE"

# ── (2) Import the box's current .env.local into Infisical (values stay local) ─
ENV_LOCAL="$DIR/.env.local"
if [ -f "$ENV_LOCAL" ]; then
  log "Importing secrets from $ENV_LOCAL into Infisical $ENV_NAME (bootstrap vars excluded)…"
  imported=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"
    [ "$key" = "$line" ] && continue                 # no '=' → skip
    case "$key" in
      INFISICAL_*|REQUIRE_SECRETS_MANAGER|SECRETS_SOURCE) continue ;;  # bootstrap, not app secrets
    esac
    # `infisical secrets set KEY=VALUE` upserts; values never printed here.
    if infisical secrets set "$line" --projectId "$PROJECT_ID" --env "$ENV_NAME" --path "$SECRETS_PATH" >/dev/null; then
      printf '  + %s\n' "$key"; imported=$((imported+1))
    else
      printf '  ! failed to set %s\n' "$key" >&2
    fi
  done < "$ENV_LOCAL"
  log "Imported $imported secret(s)."
else
  log "No $ENV_LOCAL found — skipping import (assuming secrets are already in Infisical)."
fi

# ── (3) Switch the PM2 process to launch via Infisical ────────────────────────
if [ "$DO_RESTART" -eq 1 ]; then
  log "Switching PM2 '$APP' to 'npm run start:secrets'…"
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a            # export the bootstrap into this shell
  ( cd "$DIR"
    pm2 delete "$APP" >/dev/null 2>&1 || true
    pm2 start npm --name "$APP" --update-env --cwd "$DIR" -- run start:secrets
    pm2 save )

  log "Verifying the app booted (REQUIRE_SECRETS_MANAGER=1 makes a non-manager start refuse)…"
  ok=0
  for _ in $(seq 1 30); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  if [ "$ok" -eq 1 ]; then
    log "Health check OK ($HEALTH_URL). The app is now sourcing secrets from Infisical."
  else
    echo "[cutover] WARNING: $HEALTH_URL did not respond in time. Check 'pm2 logs $APP' —" >&2
    echo "          a guard failure prints '[secrets] REQUIRE_SECRETS_MANAGER ...'." >&2
    echo "          NOT scrubbing .env.local. Re-run after fixing." >&2
    exit 1
  fi
else
  log "--no-restart: left PM2 untouched. deploy.yml will switch it on the next deploy (deploy.env present)."
fi

# ── (3 tail) Scrub .env.local — opt-in, with a backup ─────────────────────────
if [ "$DO_SCRUB" -eq 1 ] && [ -f "$ENV_LOCAL" ]; then
  ts="$(date +%Y%m%d-%H%M%S)"
  cp "$ENV_LOCAL" "$ENV_LOCAL.bak.$ts"
  : > "$ENV_LOCAL"
  log "Scrubbed $ENV_LOCAL (backup: $ENV_LOCAL.bak.$ts). Secrets now come only from Infisical."
elif [ -f "$ENV_LOCAL" ]; then
  log "Done. Verify, then scrub the now-redundant local secrets:  bash scripts/infisical-prod-cutover.sh --scrub --no-restart"
fi

log "Cutover complete."
