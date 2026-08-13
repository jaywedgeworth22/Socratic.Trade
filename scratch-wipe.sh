CONTAINER_NAME=$(docker ps --format '{{.Names}}' | grep '^d83b1aykr03uwr32yhgzaiay' | head -n1)
AWS_ACCESS_KEY_ID=$(docker exec $CONTAINER_NAME bash -c 'for pid in /proc/[0-9]*; do cat $pid/environ 2>/dev/null | tr "\0" "\n" | grep -E "^AWS_ACCESS_KEY_ID="; done | head -n1 | cut -d= -f2')
AWS_SECRET_ACCESS_KEY=$(docker exec $CONTAINER_NAME bash -c 'for pid in /proc/[0-9]*; do cat $pid/environ 2>/dev/null | tr "\0" "\n" | grep -E "^AWS_SECRET_ACCESS_KEY="; done | head -n1 | cut -d= -f2')
AWS_S3_ENDPOINT=$(docker exec $CONTAINER_NAME bash -c 'for pid in /proc/[0-9]*; do cat $pid/environ 2>/dev/null | tr "\0" "\n" | grep -E "^AWS_S3_ENDPOINT="; done | head -n1 | cut -d= -f2')

docker run --rm \
  -e AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  -e AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  -e AWS_DEFAULT_REGION="eu-central-003" \
  amazon/aws-cli \
  --endpoint-url "$AWS_S3_ENDPOINT" \
  s3 rm "s3://jays-socratic-trade-eu/trading-live/app.db/" --recursive

docker exec $CONTAINER_NAME rm -f /app/data/.litestream-disabled
docker restart $CONTAINER_NAME
