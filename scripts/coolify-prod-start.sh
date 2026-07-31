#!/usr/bin/env bash
# Boot script for the PRODUCTION app on the Coolify box (socratictrade.com).
# Coolify start_command runs this script directly; it self-wraps in
# scripts/infisical-run.mjs, so by phase 2 the full Infisical `prod` env
# (app secrets + AWS_*) is present.
#
# Phase 1 (no secrets yet): download pinned litestream + infisical CLI binaries
#   onto the persistent volume (cached across restarts), put them on PATH, then
#   re-exec this script under infisical-run.
# Phase 2 (secrets injected), gated by the DB_BOOTSTRAP runtime env var:
#   fresh (default) - start the app with whatever is in /app/data (empty on the
#                     first boot). An empty DB has no users and no broker
#                     accounts, so the scheduler cannot place orders. Safe to
#                     run while the Mac production process is still live.
#   live            - one-time restore of the production DB from the litestream
#                     R2 replica (guarded by a marker file on the volume), then
#                     run under `litestream replicate -exec` so PITR backup
#                     continuity is preserved. Flip to live ONLY after the Mac
#                     pm2 `trading` + `litestream` processes are stopped --
#                     otherwise two schedulers trade the same broker accounts.
#
# Requires NIXPACKS_PKGS="gnutar gzip" on the Coolify app (tar for the release
# tarballs; node/bash/coreutils are already in the nixpacks image).
set -euo pipefail

# Pinned BACK from 0.5.14 (2026-07-10): 0.5.14 in this container churned ~20
# sockets/s to the R2 endpoint and held thousands of dead TCP socks (peak 16.8k
# fds on one PID, ~715MB of pinned receive buffers), driving the kernel to
# tcp_mem exhaustion -- every connection's receive window clamped to ~6KB, git
# clones from GitHub trickled at ~20KB/s and died mid-transfer ("TLS unexpected
# eof"), wedging ALL Coolify deploys on the box. All 0.5.x releases read/write
# the same LTX replica format, so moving within 0.5.x is replica-compatible
# (the 0.5.14 restore at cutover read history written by earlier 0.5.x).
# Re-upgrade only after upstream fixes the socket churn.
# Full diagnosis: docs/rollouts/2026-07-10-deploy-blocker-tcpmem-litestream.md
LITESTREAM_VERSION="0.5.12"
INFISICAL_CLI_VERSION="0.43.98"  # matches the version production ran on the Mac

DATA_DIR="/app/data"
BIN_DIR="$DATA_DIR/.bin"
DB_PATH="$DATA_DIR/app.db"
MARKER="$DATA_DIR/.restored-from-replica"
CONFIG="/app/litestream.coolify.yml"

log() { echo "[coolify-prod-start] $*"; }

# Download $1 to $2 (node is guaranteed in the image; curl is not).
fetch() {
  node -e '
    const fs = require("node:fs");
    const [url, dest] = process.argv.slice(1);
    fetch(url, { redirect: "follow" })
      .then((r) => { if (!r.ok) throw new Error(url + " -> HTTP " + r.status); return r.arrayBuffer(); })
      .then((b) => fs.writeFileSync(dest, Buffer.from(b)))
      .catch((e) => { console.error("[coolify-prod-start] download failed:", e.message); process.exit(1); });
  ' "$1" "$2"
}

# Download a release tarball and install a single named binary into BIN_DIR.
install_from_tarball() {
  url="$1"; binary="$2"
  tmp="$(mktemp -d)"
  fetch "$url" "$tmp/pkg.tar.gz"
  tar -xzf "$tmp/pkg.tar.gz" -C "$tmp"
  found="$(find "$tmp" -type f -name "$binary" | head -1)"
  if [ -z "$found" ]; then
    log "ERROR: $binary not found in $url"
    exit 1
  fi
  mv "$found" "$BIN_DIR/$binary"
  chmod +x "$BIN_DIR/$binary"
  rm -rf "$tmp"
}

if [ -z "${COOLIFY_PROD_PHASE2:-}" ]; then
  mkdir -p "$BIN_DIR"
  ARCH="$(uname -m)"
  case "$ARCH" in
    aarch64|arm64)
      LITESTREAM_ARCH="arm64"
      INFISICAL_ARCH="arm64"
      ;;
    *)
      LITESTREAM_ARCH="x86_64"
      INFISICAL_ARCH="amd64"
      ;;
  esac
  # Version-aware install: BIN_DIR lives on the persistent volume, so a plain
  # existence check would keep serving a stale cached binary forever after a
  # version change ("litestream version" prints the bare number, e.g. 0.5.12).
  installed_litestream="$("$BIN_DIR/litestream" version 2>/dev/null || true)"
  if [ "$installed_litestream" != "$LITESTREAM_VERSION" ]; then
    log "installing litestream $LITESTREAM_VERSION ($LITESTREAM_ARCH) (cached: ${installed_litestream:-none})"
    install_from_tarball \
      "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-${LITESTREAM_ARCH}.tar.gz" \
      litestream
  fi
  if [ ! -x "$BIN_DIR/infisical" ]; then
    log "installing infisical CLI $INFISICAL_CLI_VERSION ($INFISICAL_ARCH)"
    install_from_tarball \
      "https://github.com/Infisical/cli/releases/download/v${INFISICAL_CLI_VERSION}/cli_${INFISICAL_CLI_VERSION}_linux_${INFISICAL_ARCH}.tar.gz" \
      infisical
  fi
  export PATH="$BIN_DIR:$PATH"
  export COOLIFY_PROD_PHASE2=1
  log "binaries ready; re-exec under infisical-run"
  exec node scripts/infisical-run.mjs -- bash "$0" "$@"
fi

# --- phase 2: Infisical secrets are in the environment ---
MODE="${DB_BOOTSTRAP:-fresh}"

if [ "$MODE" != "live" ]; then
  log "DB_BOOTSTRAP=$MODE - starting WITHOUT restore/replication (empty-DB safe mode)"
  exec npm run start
fi

if [ ! -f "$MARKER" ]; then
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  for f in "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"; do
    if [ -e "$f" ]; then
      log "moving aside pre-restore file $f"
      mv "$f" "$f.pre-restore-$ts"
    fi
  done
  log "restoring production DB from litestream replica"
  litestream restore -config "$CONFIG" "$DB_PATH"
  echo "$ts restored from litestream replica" > "$MARKER"
  log "restore complete"
fi

log "DB_BOOTSTRAP=live - starting under litestream replicate"
exec litestream replicate -config "$CONFIG" -exec "npm run start"
