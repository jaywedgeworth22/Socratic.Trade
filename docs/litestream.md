# Litestream WAL Replication

Continuous SQLite backup via [Litestream](https://litestream.io). Streams the WAL from
`data/app.db` to an S3 bucket in real time; a local 24-hour file replica provides a
no-credentials fallback for fast restores.

## Setup

### 1. Install Litestream

```bash
# macOS
brew install litestream

# Linux (amd64)
curl -L https://github.com/benbjohnson/litestream/releases/latest/download/litestream-linux-amd64.tar.gz \
  | tar -xzC /usr/local/bin
```

### 2. Set credentials

Add to `/home/ubuntu/apps/trading-live/.env.local` (or export in the PM2 env):

```bash
LITESTREAM_S3_BUCKET=trading-backups
LITESTREAM_S3_REGION=us-east-1
LITESTREAM_S3_ACCESS_KEY_ID=AKIAxxx
LITESTREAM_S3_SECRET_ACCESS_KEY=xxx
```

### 3. Copy the config

```bash
cp litestream.yml /home/ubuntu/apps/trading-live/litestream.yml
```

### 4. Start as a PM2 process

```bash
pm2 start litestream \
  --name "litestream" \
  -- replicate \
  --config /home/ubuntu/apps/trading-live/litestream.yml

pm2 save
```

### 5. Verify

```bash
litestream snapshots -config /home/ubuntu/apps/trading-live/litestream.yml
# should show a recent snapshot with age near "0s"
```

## S3 IAM policy (minimal)

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:ListBucket"],
    "Resource": [
      "arn:aws:s3:::trading-backups",
      "arn:aws:s3:::trading-backups/*"
    ]
  }]
}
```

## Disaster recovery

### Restore from S3

```bash
LITESTREAM_S3_BUCKET=trading-backups \
LITESTREAM_S3_REGION=us-east-1 \
LITESTREAM_S3_ACCESS_KEY_ID=AKIAxxx \
LITESTREAM_S3_SECRET_ACCESS_KEY=xxx \
bash scripts/litestream-restore.sh /tmp/app.db.restored

# Verify row counts, then swap:
pm2 stop trading
cp /tmp/app.db.restored /home/ubuntu/apps/trading-live/data/app.db
pm2 restart trading
```

### Restore from local 24h file backup (no credentials needed)

```bash
pm2 stop trading
cp /home/ubuntu/apps/backups/trading-live/app.db \
   /home/ubuntu/apps/trading-live/data/app.db
pm2 restart trading
```

## Monitoring

```bash
# Latest snapshot age:
litestream snapshots -config /home/ubuntu/apps/trading-live/litestream.yml

# Replication lag (WAL position):
litestream status -config /home/ubuntu/apps/trading-live/litestream.yml
```
