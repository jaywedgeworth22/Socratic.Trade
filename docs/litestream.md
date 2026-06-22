# Litestream WAL Replication

Continuous SQLite backup via [Litestream](https://litestream.io) **0.5.x**. Streams the
WAL from `~/apps/trading-live/data/app.db` to a Cloudflare R2 bucket as LTX files.

The app runs locally on macOS under PM2; Litestream runs as a sidecar PM2 process
(`litestream`) launched by `scripts/run-litestream.sh`.

> **0.5.x note:** Litestream 0.5 only supports a **single replica per database**
> (the old multi-replica config errors with "multiple replicas on a single database
> are no longer supported"). It also replaced the `snapshots`/`generations` model with
> **LTX files** — inspect them with `litestream ltx`, not `litestream snapshots`.

## Setup

### 1. Install

```bash
brew install benbjohnson/litestream/litestream
litestream version   # expect 0.5.x
```

### 2. Create an R2 bucket + token

dash.cloudflare.com → R2 → create a bucket (e.g. `trading-live-backups`) →
**Manage R2 API Tokens** → create a token with **Object Read & Write** scoped to that
bucket. You get an **Access Key ID**, a **Secret Access Key**, and an **endpoint URL**
(`https://<account-id>.r2.cloudflarestorage.com`).

### 3. Add credentials to `~/apps/trading-live/.env.local`

```bash
LITESTREAM_S3_BUCKET=trading-live-backups
LITESTREAM_S3_REGION=auto
LITESTREAM_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
LITESTREAM_S3_ACCESS_KEY_ID=...
LITESTREAM_S3_SECRET_ACCESS_KEY=...
```

### 4. Deploy the config + launcher and start under PM2

```bash
cp litestream.yml ~/apps/trading-live/litestream.yml
cp scripts/run-litestream.sh ~/apps/trading-live/run-litestream.sh

pm2 start ~/apps/trading-live/run-litestream.sh --name litestream --interpreter bash
pm2 save
```

The launcher sources the creds itself (via `eval`, so it survives PM2 restarts and
`pm2 resurrect` on reboot — unlike relying on a shell that happened to have the vars
exported at `pm2 start` time).

### 5. Verify

```bash
# Config parses + replica is wired:
litestream databases -config ~/apps/trading-live/litestream.yml

# LTX files actually landed in R2 (need creds exported, or run via the launcher's env):
litestream ltx -config ~/apps/trading-live/litestream.yml ~/apps/trading-live/data/app.db

# PM2 process is stable (restart count should stay at 0):
pm2 show litestream
```

Healthy output log shows `replicating to type=s3 bucket=...`, periodic
`ltx file uploaded`, then `replica sync` ticking each second.

## Disaster recovery

`scripts/litestream-restore.sh` reads creds from `.env.local` if they are not already
exported, then restores the latest backup:

```bash
bash scripts/litestream-restore.sh /tmp/app.db.restored

# Verify, then swap in:
sqlite3 /tmp/app.db.restored 'SELECT count(*) FROM audit_events;'
pm2 stop trading
cp /tmp/app.db.restored ~/apps/trading-live/data/app.db
pm2 restart trading
```

Point-in-time restore (0.5.x): add `-timestamp 2026-06-21T18:00:00Z` or
`-txid <hex>` to the `litestream restore` call.

## Local snapshot (optional)

0.5.x cannot also mirror to a local file replica (single-replica limit). If you want a
no-credentials local copy, schedule a periodic SQLite backup independently, e.g. a
`launchd` job running:

```bash
sqlite3 ~/apps/trading-live/data/app.db ".backup ~/apps/backups/trading-live/app.db"
```

## Monitoring

```bash
litestream ltx -config ~/apps/trading-live/litestream.yml ~/apps/trading-live/data/app.db | tail
pm2 logs litestream --lines 30
```
