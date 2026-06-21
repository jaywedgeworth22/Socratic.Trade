#!/usr/bin/env bash
# Restore the trading-live SQLite DB from the Litestream S3 replica.
# Usage: bash scripts/litestream-restore.sh [output-path]
#
# Required env vars:
#   LITESTREAM_S3_BUCKET, LITESTREAM_S3_ACCESS_KEY_ID, LITESTREAM_S3_SECRET_ACCESS_KEY
# Optional:
#   LITESTREAM_S3_REGION  (default: us-east-1)
set -euo pipefail

OUTPUT="${1:-/home/ubuntu/apps/trading-live/data/app.db.restored}"
CONFIG="${LITESTREAM_CONFIG:-/home/ubuntu/apps/trading-live/litestream.yml}"

: "${LITESTREAM_S3_BUCKET?Required: LITESTREAM_S3_BUCKET}"
: "${LITESTREAM_S3_ACCESS_KEY_ID?Required: LITESTREAM_S3_ACCESS_KEY_ID}"
: "${LITESTREAM_S3_SECRET_ACCESS_KEY?Required: LITESTREAM_S3_SECRET_ACCESS_KEY}"

echo "Restoring from S3 replica to: $OUTPUT"
litestream restore \
  -config "$CONFIG" \
  -replica s3 \
  -o "$OUTPUT" \
  /home/ubuntu/apps/trading-live/data/app.db

echo ""
echo "Restore complete: $OUTPUT"
echo "Verify the DB before swapping:"
echo "  sqlite3 \"$OUTPUT\" 'SELECT count(*) FROM audit_events;'"
echo ""
echo "To activate the restored file:"
echo "  pm2 stop trading"
echo "  cp \"$OUTPUT\" /home/ubuntu/apps/trading-live/data/app.db"
echo "  pm2 restart trading"
