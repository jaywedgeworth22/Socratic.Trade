#!/usr/bin/env bash
# Run npm ci with optional SSH auth for private git dependencies.
#
# Set CONGRESS_TRADING_SHARED_DEPLOY_KEY to a private key, or
# CONGRESS_TRADING_SHARED_DEPLOY_KEY_FILE to a key file path. When neither is set,
# this falls back to the caller's normal git/ssh credentials.
set -euo pipefail

KEY_FILE=""
CLEANUP_KEY_FILE=""

if [ -n "${CONGRESS_TRADING_SHARED_DEPLOY_KEY_FILE:-}" ]; then
  KEY_FILE="$CONGRESS_TRADING_SHARED_DEPLOY_KEY_FILE"
elif [ -n "${CONGRESS_TRADING_SHARED_DEPLOY_KEY:-}" ]; then
  tmp_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
  KEY_FILE="$tmp_dir/congress_trading_shared_deploy_key_$$"
  mkdir -p "$(dirname "$KEY_FILE")"
  printf '%s\n' "$CONGRESS_TRADING_SHARED_DEPLOY_KEY" > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  CLEANUP_KEY_FILE="$KEY_FILE"
fi

cleanup() {
  if [ -n "$CLEANUP_KEY_FILE" ]; then
    rm -f "$CLEANUP_KEY_FILE"
  fi
}
trap cleanup EXIT

if [ -n "$KEY_FILE" ]; then
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  if ! ssh-keygen -F github.com >/dev/null 2>&1; then
    ssh-keyscan github.com >> "$HOME/.ssh/known_hosts"
  fi
  export GIT_SSH_COMMAND="ssh -i $KEY_FILE -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"
fi

npm ci "$@"
