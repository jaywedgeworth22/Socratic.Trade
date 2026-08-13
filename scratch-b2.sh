rawEnv=$(infisical export --env=prod --format=json)
AWS_ACCESS_KEY_ID=$(echo $rawEnv | grep -o '"key":"AWS_ACCESS_KEY_ID","value":"[^"]*"' | cut -d'"' -f8)
AWS_SECRET_ACCESS_KEY=$(echo $rawEnv | grep -o '"key":"AWS_SECRET_ACCESS_KEY","value":"[^"]*"' | cut -d'"' -f8)
AWS_S3_ENDPOINT=$(echo $rawEnv | grep -o '"key":"AWS_S3_ENDPOINT","value":"[^"]*"' | cut -d'"' -f8)

docker run --rm \
  -e AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  -e AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  amazon/aws-cli \
  --endpoint-url "$AWS_S3_ENDPOINT" \
  s3 ls "s3://jays-socratic-trade-eu/trading-live/app.db/"
