# Litestream WAL Replication

Continuous SQLite backup via [Litestream](https://litestream.io) **0.5.x**. Streams the
WAL as LTX files to an S3-compatible object store.

**Production (Coolify, 2026-08-07+):** active replica is **Backblaze B2** EU Central
(`jays-socratic-trade-eu`, endpoint `s3.eu-central-003.backblazeb2.com`) via
`litestream.coolify.yml` + Infisical `AWS_*`. Cloudflare R2 holds a **historic** freeze
until B2 restore is proven — do not delete R2 objects yet. Details:
`docs/rollouts/2026-08-07-litestream-b2-backup.md`.

Local Mac notes below (`litestream.yml` + `scripts/run-litestream.sh`) are optional
dev/sidecar history; production does **not** use Mac PM2 litestream.

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
AWS_S3_BUCKET_NAME=trading-live-backups
AWS_REGION=auto
AWS_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

(Names follow the fleet-wide `AWS_*` convention shared with Congress.Trade —
renamed from the older `LITESTREAM_S3_*` set on 2026-07-30.)

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

## Restore verification status (G9a, 2026-07-01)

**Restore has NOT yet been exercised.** Only the *replicate* (write) path has been
verified live in production — see `docs/rollouts/2026-06-21-litestream-r2-live.md`
("Verification" section: `litestream databases`/`litestream ltx` confirmed LTX files
landing in R2, `pm2 show litestream` stable). That note's own follow-ups explicitly
flagged the gap ("Consider a periodic restore drill") and it was never closed out —
no rollout note or audit trail records `scripts/litestream-restore.sh` (or the
underlying `litestream restore`) having actually been run and its output checked
against `data/app.db`. Replication succeeding is NOT proof restore works: a wrong
`-config` path, a stale/incompatible LTX generation, or a permissions gap on the R2
read side would only surface at restore time.

Until a drill is recorded, treat backups as **unverified** for disaster-recovery
purposes — replicated bytes exist in R2, but the recovery procedure itself is
untested end-to-end. This finding requires no infra change (the credentials and
production host are out of reach for a non-production agent); it is an operator
runbook step that must be performed once from `~/apps/trading-live`.

### Runbook: perform and record a restore drill

Run this periodically (recommend: quarterly, and after any Litestream/litestream.yml
version bump) from a shell with the production `AWS_*` creds available
(via `.env.local` or `infisical run`, per `docs/deployment.md`):

```bash
# 1. Restore the latest replica to a scratch path (does NOT touch the live app.db).
bash scripts/litestream-restore.sh /tmp/app.db.restored

# 2. Sanity-check row counts against a table that changes frequently, and compare
#    against the live DB's count (expect the restored count to be close, modulo
#    whatever wrote since the last LTX sync).
sqlite3 /tmp/app.db.restored 'SELECT count(*) FROM audit_events;'
sqlite3 ~/apps/trading-live/data/app.db 'SELECT count(*) FROM audit_events;'

# 3. Confirm the restored file is a valid, non-corrupt SQLite DB.
sqlite3 /tmp/app.db.restored 'PRAGMA integrity_check;'   # expect: ok

# 4. Clean up the scratch file (do NOT cp it over the live app.db as part of a drill).
rm /tmp/app.db.restored
```

Record the outcome (date, LTX generation/txid if noted, row-count delta, integrity
result) in a `docs/rollouts/YYYY-MM-DD-litestream-restore-drill.md` note so future
agents/operators can see when restore was last actually proven to work, not just
assumed from replication health.

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
