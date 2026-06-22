#!/usr/bin/env bash
# Restore the trading-live SQLite DB from the Litestream R2 replica (Litestream 0.5.x).
# Usage: bash scripts/litestream-restore.sh [output-path]
#
# Required env vars (or have them in ~/apps/trading-live/.env.local):
#   LITESTREAM_S3_BUCKET, LITESTREAM_S3_ENDPOINT,
#   LITESTREAM_S3_ACCESS_KEY_ID, LITESTREAM_S3_SECRET_ACCESS_KEY
# Optional:
#   LITESTREAM_S3_REGION  (default: auto, for Cloudflare R2)
set -euo pipefail

OUTPUT="${1:-/Users/jay/apps/trading-live/data/app.db.restored}"
CONFIG="${LITESTREAM_CONFIG:-/Users/jay/apps/trading-live/litestream.yml}"
DB="/Users/jay/apps/trading-live/data/app.db"

# Fall back to .env.local if the creds are not already exported.
if [[ -z "${LITESTREAM_S3_BUCKET:-}" && -f /Users/jay/apps/trading-live/.env.local ]]; then
  set -a
  eval "$(grep -E '^LITESTREAM_' /Users/jay/apps/trading-live/.env.local)"
  set +a
fi

: "${LITESTREAM_S3_BUCKET?Required: LITESTREAM_S3_BUCKET}"
: "${LITESTREAM_S3_ACCESS_KEY_ID?Required: LITESTREAM_S3_ACCESS_KEY_ID}"
: "${LITESTREAM_S3_SECRET_ACCESS_KEY?Required: LITESTREAM_S3_SECRET_ACCESS_KEY}"

echo "Restoring latest backup to: $OUTPUT"
# 0.5.x: single replica, no -replica flag. Give the configured DB path; -o sets output.
litestream restore -config "$CONFIG" -o "$OUTPUT" "$DB"

echo ""
echo "Restore complete: $OUTPUT"
echo "Verify before swapping:"
echo "  sqlite3 \"$OUTPUT\" 'SELECT count(*) FROM audit_events;'"
echo ""
echo "To activate the restored file:"
echo "  pm2 stop trading"
echo "  cp \"$OUTPUT\" $DB"
echo "  pm2 restart trading"
