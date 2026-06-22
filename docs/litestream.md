# Litestream WAL Replication

Continuous SQLite backup via [Litestream](https://litestream.io). Streams the WAL from
`~/apps/trading-live/data/app.db` to an S3 bucket in real time; a local 24-hour file
replica provides a no-credentials fallback for fast restores.

The app runs locally on macOS with PM2; Litestream runs as a sidecar PM2 process.

## Setup

### 1. Install Litestream

```bash
brew install benbjohnson/litestream/litestream
```

### 2. Create an S3 bucket

Any S3-compatible provider works. Cloudflare R2 is cheapest (free egress):
- Create a bucket at dash.cloudflare.com → R2
- Create an API token with Object Read & Write on that bucket
- Set `LITESTREAM_S3_REGION=auto` and endpoint URL (see litestream.yml comments)

For AWS S3, create an IAM key with this policy:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:ListBucket"],
    "Resource": ["arn:aws:s3:::YOUR-BUCKET","arn:aws:s3:::YOUR-BUCKET/*"]
  }]
}
```

### 3. Set credentials

Add to `~/apps/trading-live/.env.local`:

```bash
LITESTREAM_S3_BUCKET=your-bucket-name
LITESTREAM_S3_REGION=us-east-1
LITESTREAM_S3_ACCESS_KEY_ID=AKIAxxx
LITESTREAM_S3_SECRET_ACCESS_KEY=xxx
```

### 4. Copy the config and start as PM2 process

```bash
cp litestream.yml ~/apps/trading-live/litestream.yml
mkdir -p ~/apps/backups/trading-live

# Load the env vars
set -a && source ~/apps/trading-live/.env.local && set +a

pm2 start litestream \
  --name "litestream" \
  -- replicate \
  --config ~/apps/trading-live/litestream.yml

pm2 save
```

### 5. Verify

```bash
litestream snapshots -config ~/apps/trading-live/litestream.yml
# should show a recent snapshot with age near "0s"
```

## Disaster recovery

### Restore from S3

```bash
export LITESTREAM_S3_BUCKET=your-bucket-name
export LITESTREAM_S3_ACCESS_KEY_ID=AKIAxxx
export LITESTREAM_S3_SECRET_ACCESS_KEY=xxx
bash scripts/litestream-restore.sh /tmp/app.db.restored

# Verify row counts:
sqlite3 /tmp/app.db.restored 'SELECT count(*) FROM audit_events;'

# Swap in:
pm2 stop trading
cp /tmp/app.db.restored ~/apps/trading-live/data/app.db
pm2 restart trading
```

### Restore from local 24h file backup (no credentials needed)

```bash
pm2 stop trading
cp ~/apps/backups/trading-live/app.db ~/apps/trading-live/data/app.db
pm2 restart trading
```

## Monitoring

```bash
litestream snapshots -config ~/apps/trading-live/litestream.yml
litestream status -config ~/apps/trading-live/litestream.yml
```
