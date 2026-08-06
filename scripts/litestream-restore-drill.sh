#!/usr/bin/env bash
# Litestream restore drill - tests end-to-end restore from the R2 replica.
#
# This script performs a full restore from the remote replica to a scratch file,
# runs integrity checks, and compares row counts against the live database.
# It does NOT modify the live app.db - it only verifies that the restore path works.
#
# Run quarterly (recommended) or after any Litestream/litestream.yml version bump.
# Record the outcome in a docs/rollouts/YYYY-MM-DD-litestream-restore-drill.md note.
#
# Usage:
#   bash scripts/litestream-restore-drill.sh
#
# Env vars (or have them in ~/apps/trading-live/.env.local):
#   AWS_S3_BUCKET_NAME, AWS_S3_ENDPOINT,
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
# Optional:
#   RESTORE_PITR_TIMESTAMP   Point-in-time restore target (ISO 8601, e.g. 2026-07-01T12:00:00Z)
#   AWS_REGION               (default: auto, for Cloudflare R2)
set -euo pipefail

# -- Config ----------------------------------------------------------------------
LIVE_DB="${LIVE_DB:-/Users/jay/apps/trading-live/data/app.db}"
LITESTREAM_CONFIG="${LITESTREAM_CONFIG:-/Users/jay/apps/trading-live/litestream.yml}"
SCRATCH_DIR="${SCRATCH_DIR:-/tmp}"
SCRATCH_DB="${SCRATCH_DIR}/app.db.restore-drill-$(date +%Y%m%d-%H%M%S)"
TIMESTAMP_FLAG=""

if [[ -n "${RESTORE_PITR_TIMESTAMP:-}" ]]; then
  TIMESTAMP_FLAG="-timestamp ${RESTORE_PITR_TIMESTAMP}"
  echo "PITR mode: restoring to ${RESTORE_PITR_TIMESTAMP}"
fi

# -- Load credentials -----------------------------------------------------------
if [[ -z "${AWS_S3_BUCKET_NAME:-}" && -f /Users/jay/apps/trading-live/.env.local ]]; then
  set -a
  eval "$(grep -E '^AWS_' /Users/jay/apps/trading-live/.env.local)"
  set +a
fi

: "${AWS_S3_BUCKET_NAME?Required: AWS_S3_BUCKET_NAME}"
: "${AWS_ACCESS_KEY_ID?Required: AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY?Required: AWS_SECRET_ACCESS_KEY}"

# -- Pre-flight -----------------------------------------------------------------
echo "=== Litestream Restore Drill ==="
echo "Date:      $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "Live DB:   ${LIVE_DB}"
echo "Scratch:   ${SCRATCH_DB}"
echo "Config:    ${LITESTREAM_CONFIG}"
echo ""

if ! command -v litestream &>/dev/null; then
  echo "ERROR: litestream not found. Install: brew install benbjohnson/litestream/litestream" >&2
  exit 1
fi

LITESTREAM_VERSION=$(litestream version 2>&1 || echo "unknown")
echo "Litestream: ${LITESTREAM_VERSION}"

# -- Step 1: Verify replication is healthy --------------------------------------
echo ""
echo "--- Step 1: Replication health ---"
litestream databases -config "${LITESTREAM_CONFIG}" 2>&1 || true

echo ""
echo "--- Step 2: Latest LTX generations (last 5) ---"
litestream ltx -config "${LITESTREAM_CONFIG}" "${LIVE_DB}" 2>&1 | tail -5 || true

# -- Step 2: Restore ------------------------------------------------------------
echo ""
echo "--- Step 3: Restoring to scratch file ---"
# shellcheck disable=SC2086
litestream restore -config "${LITESTREAM_CONFIG}" -o "${SCRATCH_DB}" ${TIMESTAMP_FLAG} "${LIVE_DB}"
echo "Restore complete: ${SCRATCH_DB}"

# -- Step 3: Integrity check ----------------------------------------------------
echo ""
echo "--- Step 4: Integrity check ---"
INTEGRITY=$(sqlite3 "${SCRATCH_DB}" 'PRAGMA integrity_check;')
echo "  Result: ${INTEGRITY}"
if [[ "${INTEGRITY}" != "ok" ]]; then
  echo "  FAILED: database integrity check failed!"
  rm -f "${SCRATCH_DB}"
  exit 1
fi

# -- Step 4: Row-count comparison -----------------------------------------------
echo ""
echo "--- Step 5: Row-count comparison (restored vs live) ---"
TABLES=("audit_events" "llm_usage" "trade_proposals" "chat_turns" "settings")
PASS=true

for table in "${TABLES[@]}"; do
  RESTORED_COUNT=$(sqlite3 "${SCRATCH_DB}" "SELECT count(*) FROM ${table};" 2>/dev/null || echo "N/A")
  LIVE_COUNT=$(sqlite3 "${LIVE_DB}" "SELECT count(*) FROM ${table};" 2>/dev/null || echo "N/A")
  if [[ "${RESTORED_COUNT}" == "N/A" || "${LIVE_COUNT}" == "N/A" ]]; then
    echo "  ${table}: N/A (table may not exist)"
    continue
  fi
  DELTA=$((LIVE_COUNT - RESTORED_COUNT))
  if [[ ${DELTA} -lt 0 ]]; then
    echo "  ${table}: restored=${RESTORED_COUNT} live=${LIVE_COUNT} delta=${DELTA} WARNING (restored > live - check replication)"
    PASS=false
  else
    echo "  ${table}: restored=${RESTORED_COUNT} live=${LIVE_COUNT} delta=+${DELTA} (expected: live has writes since last replication)"
  fi
done

# -- Step 5: Cleanup ------------------------------------------------------------
echo ""
echo "--- Step 6: Cleanup ---"
rm -f "${SCRATCH_DB}"
echo "  Removed: ${SCRATCH_DB}"

# -- Summary ---------------------------------------------------------------------
echo ""
echo "=== Drill Complete ==="
if [[ "${PASS}" == "true" ]]; then
  echo "Result: PASS - restore verified successfully."
  echo ""
  echo "Record this result:"
  echo "  Create: docs/rollouts/$(date +%Y-%m-%d)-litestream-restore-drill.md"
  echo "  Template:"
  echo "    - Date: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "    - Litestream version: ${LITESTREAM_VERSION}"
  echo "    - Integrity check: ${INTEGRITY}"
  echo "    - Row-count deltas: within expected range"
  echo "    - Verified: restore from R2 replica works end-to-end"
else
  echo "Result: WARNING - row-count discrepancies found. Review the delta above."
fi
