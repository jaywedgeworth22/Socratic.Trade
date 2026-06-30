#!/usr/bin/env bash
# Run npm ci with optional auth for the private GitHub Packages dependency.
#
# Set NODE_AUTH_TOKEN to a GitHub token with read access to
# @jaywedgeworth22/congress-trading-shared. The legacy SSH deploy-key path is
# kept for older lockfiles and local rollbacks.
set -euo pipefail

KEY_FILE=""
CLEANUP_KEY_FILE=""
NPMRC_FILE=""

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
  if [ -n "$NPMRC_FILE" ]; then
    rm -f "$NPMRC_FILE"
  fi
}
trap cleanup EXIT

if [ -n "${NODE_AUTH_TOKEN:-}" ]; then
  tmp_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
  NPMRC_FILE="$tmp_dir/congress_trading_shared_npmrc_$$"
  {
    printf '@jaywedgeworth22:registry=https://npm.pkg.github.com\n'
    printf '//npm.pkg.github.com/:_authToken=%s\n' "$NODE_AUTH_TOKEN"
  } > "$NPMRC_FILE"
  chmod 600 "$NPMRC_FILE"
  export NPM_CONFIG_USERCONFIG="$NPMRC_FILE"
fi

if [ -n "$KEY_FILE" ]; then
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  if ! ssh-keygen -F github.com >/dev/null 2>&1; then
    ssh-keyscan github.com >> "$HOME/.ssh/known_hosts"
  fi
  export GIT_SSH_COMMAND="ssh -i $KEY_FILE -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"
fi

npm ci "$@"
