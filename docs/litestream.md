# Litestream WAL Replication

Continuous SQLite backup via [Litestream](https://litestream.io) **0.5.x**. Streams the
WAL as LTX files to an S3-compatible object store.

**Production (Coolify, 2026-08-07+):** active replica is **Backblaze B2** EU Central
(`jays-socratic-trade-eu`, endpoint `s3.eu-central-003.backblazeb2.com`) via
`litestream.coolify.yml` + Infisical `AWS_*`. B2 restore to a host scratch path is
**VERIFIED** (2026-08-18 UTC).  Cloudflare R2 remains the weekly cold snapshot
(`cold-snapshots/`), not a second Litestream writer.  Weekly retain=1 is
**VERIFIED** (exactly one `cold-snapshots/` object).  Details:
`docs/rollouts/2026-08-07-litestream-b2-backup.md` and
`docs/rollouts/2026-08-17-litestream-restore-drill.md`.

**All three fleet apps (ST, CT, UM) run litestream IN-CONTAINER** since the August
2026 Hetzner rebuild.  The 2026-08-01 host-level `litestream-congress` systemd unit
was an interim measure and no longer exists — any doc describing Congress.Trade
litestream on the host is historical.

## B2 lifecycle caps restore depth

All fleet B2 buckets carry lifecycle rules **hide after 14 days + delete hidden
after 1 day**.  B2 applies these to litestream's LTX objects like any other file,
so point-in-time restore depth from B2 is hard-capped at **~15 days** regardless
of what litestream's own retention settings claim.  Do not plan a restore deeper
than that from B2.  The weekly R2 cold snapshot is SECOND-PROVIDER disaster
recovery, not deeper history: retain=1 means it is a single point at most ~7
days old.  No provider holds a recovery point older than ~15 days.

## Weekly R2 cold snapshot is gzipped (2026-08-31)

The weekly cold snapshot (`src/lib/r2-cold-snapshot.ts`, Sunday ~03:17 UTC due-job)
uploads `cold-snapshots/app-YYYY-MM-DD.db.gz` — the better-sqlite3 `backup()` file
gzip-streamed during the multipart upload (the raw DB reached ~9.7 GB, ~90% of the
R2 free tier; compressed is expected at ~2.5-4 GB).  Retention is retain=1 across
BOTH extensions, so the first successful `.gz` upload prunes the last legacy raw
`.db` object.  **Restore from a cold snapshot now needs a gunzip step first:**

```bash
# Download (rclone/aws cli against the historic R2 bucket), then:
gunzip app-2026-08-31.db.gz          # yields app-2026-08-31.db
sqlite3 app-2026-08-31.db 'PRAGMA integrity_check;'   # expect: ok
```

After gunzip the file is a plain SQLite DB — treat it exactly like the old raw
`.db` snapshot.

## L1 suffix heal precedent (2026-08-31)

A stuck ST L2 compaction (litestream 0.5.12 trying to upload ONE giant L2 file
covering a multi-day L1 backlog, failing repeatedly) had been tripping the B2
Class B download cap daily since 8/29.  Healed 2026-08-31 with the L1 suffix heal
in its keep-above-snapshot-boundary variant: `scripts/litestream-l1-suffix-heal.py`
keeps the newest contiguous L1 suffix, deletes older L1 plus all L2/L3 so Compact
rebuilds small files, and never touches L0, L9, `cold-snapshots/`, or any other
bucket (dry-run by default; `--apply` to delete).  Use that script — not ad-hoc
deletes — if the pattern recurs.

Local Mac notes below (`litestream.yml` + `scripts/run-litestream.sh`) are optional
dev/sidecar history; production does **not** use Mac PM2 litestream.

> **0.5.x note:** Litestream 0.5 only supports a **single replica per database**
> (the old multi-replica config errors with "multiple replicas on a single database
> are no longer supported"). It also replaced the `snapshots`/`generations` model with
> **LTX files** — inspect them with `litestream ltx`, not `litestream snapshots`.

## Setup (retired Mac / PM2 path — not production)

Production Litestream runs in the Coolify container via `litestream.coolify.yml`.
The Mac `~/apps/trading-live` steps below are rollback/dev history.  Do not start
Mac `pm2` `litestream` while Coolify runs `DB_BOOTSTRAP=live`.

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

## Restore verification status (2026-08-18 UTC)

**B2 restore to scratch is VERIFIED.**  ASC ran `litestream restore` on
`fleet-hetzner-nbg1` to two scratch paths (both off the live volume):
`/data/scratch/socratic-restore-20260818/app.db` (started 2026-08-18T01:12:26Z,
file complete ~01:14Z, 4.9G) and
`/data/backups/restore-proof/socratic-restore-scratch-20260817/app.db`
(litestream 0.5.16, 107s, exit 0, 4.9G).  `PRAGMA integrity_check` was `ok`.
Newest LTX at the second restore: level 0 txid `0000000000080781` @
2026-08-18T01:14:43Z.  A later live compare (8:19pm CT) is seconds / ~31 rows
ahead of the scratch, as expected.  Site stayed up.  No bounce.  No
`FORCE_RESTORE`.  No Mac pm2.

Also **VERIFIED**: decrypt of one stored credential on the scratch (`fred`
last-4 `6dd4`; do not write plaintext or `ENCRYPTION_KEY`); R2 weekly retain=1
(exactly one `cold-snapshots/app-2026-08-16.db`).  `R2_ARCHIVE_KEEP_GENERATIONS=2`
is unused on ST.

Full receipts: `docs/rollouts/2026-08-17-litestream-restore-drill.md`.

The 2026-07-01 G9a gap (replicate proven, restore never run) is closed for the B2
path.  Repeat after a Litestream / `litestream.coolify.yml` version bump.

### Runbook: perform and record a restore drill

Run this periodically (recommend: quarterly, and after any Litestream / `litestream.coolify.yml`
version bump).  Production is Coolify on `fleet-hetzner-nbg1`, not Mac pm2.  The 2026-08-18
drill used host scratch + `litestream restore -config …/litestream.coolify.yml` (creds from
the running socratic litestream process env, shredded after).  The Mac-oriented script
below is still valid for a local replica.  Do not `cp` over live `/app/data/app.db` as part
of a drill.  Do not bounce.  Do not set `FORCE_RESTORE`.

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

## Compaction health - the L2 mega-upload wedge

### The failure mode

Litestream 0.5's level-2 compaction walks forward from the last L2 `maxTXID` and folds
**the whole remaining L1 chain into one output object**.  That is fine when it runs every
few minutes.  It becomes a trap the moment L2 stalls for any reason - a B2 endpoint flake,
a killed multipart, an exhausted download cap - because L0/L1 keep advancing while L2 does
not.  Each retry therefore has to download *more* L1 than the last one and upload a *bigger*
single object than the last one, so the loop diverges instead of converging.  It has never
self-healed: the fleet has hand-healed it four times (ST 2026-08-13, ST 2026-08-22,
UM 2026-08-27, ST 2026-08-31/09-01).

The retry storm also burns the **shared** Backblaze Class B download allowance, which is
fleet-wide - so a wedged ST L2 starves CT's and UM's compaction too.  That makes the cap
error a *symptom* that appears late, well after the real failure.  Do not stop at it.

Signature log lines, in the order they usually appear.  The upload failures come first:

```
level=ERROR msg="compaction failed" system=store db=app.db level=2 \
  error="write ltx file: s3: upload to trading-live/app.db/0002/<min>-<max>.ltx: \
  read upload data failed: read page header 312: unexpected EOF"

level=ERROR msg="compaction failed" system=store db=app.db level=2 \
  error="write ltx file: s3: upload to trading-live/app.db/0002/<min>-<max>.ltx: \
  read upload data failed: read page header 402: read lz4 trailer: expected lz4 end frame"
```

Then, once the retries have eaten the day's Class B allowance, the same 5-minute tick
starts failing earlier - on the *read* side - and the message changes shape:

```
level=ERROR msg="compaction failed" system=store db=app.db level=2 \
  error="open ltx file: s3: get object trading-live/app.db/0001/<min>-<max>.ltx: \
  ... AccessDenied: Cannot download file, download bandwidth or transaction \
  (Class B) cap exceeded."
```

Two tells that this is the mega-upload wedge and not a credentials or endpoint problem:
`level=2` on every failure while `level=0` `ltx file uploaded` lines keep flowing normally
in between, and a `0002/` object name whose `<min>` TXID never advances across retries.

### The heal: `scripts/litestream-l1-boundary-trim.py`

Installed on `fleet-hetzner-nbg1` as `/usr/local/sbin/litestream-l1-boundary-trim`; the
repo copy is the source of truth for review and re-installation.  It lists the newest L9
snapshot, reads its `maxTXID` as a boundary, and deletes every L1 object whose `maxTXID` is
at or below that boundary.  This is safe by construction: a full snapshot already contains
those transactions, so a restore is snapshot + the remaining L1/L0 chain.

```bash
# Dry run (default) - prints the plan and changes nothing.
ssh root@100.69.77.26 /usr/local/sbin/litestream-l1-boundary-trim

# Apply.
ssh root@100.69.77.26 /usr/local/sbin/litestream-l1-boundary-trim --apply
```

**Run it right after the nightly snapshot lands (~00:00Z).**  The snapshot is what advances
the boundary, so trimming immediately afterwards leaves the next L2 compaction with only
minutes of L1 to fold in - a small upload that succeeds.  Running it long after the snapshot
still works but heals less, because the L1 accumulated since the snapshot is exactly what
L2 still has to carry.

Guards, all of which abort rather than proceed: no L9 snapshot found; the newest snapshot is
under 100 MB (a truncated or in-progress snapshot must never define the boundary); the
snapshot is older than 48h; or the trim would leave a restore hole between the snapshot and
the first kept L1 object.  Unparseable object names are warned about and skipped, never
deleted.

Listings and deletes are Backblaze **Class A/C** transactions.  They are not metered against
the Class B download cap, so this tool works *while downloads are capped* - which is exactly
the state the wedge puts the bucket in.

### Pre-flight before `--apply` - what the guards do NOT cover

The built-in guards are necessary, not sufficient.  Three gaps are known and unfixed in the
script as installed; check them by hand before applying, and treat an armed one-shot as
running without them.

1. **Is the snapshot from *tonight's* run?**  The freshness guard is 48h, so a snapshot from
   yesterday passes.  If the nightly snapshot is late or failed, a 00:02Z one-shot trims to
   the *old* boundary, exits 0, and lapses - leaving roughly a full day of L1 for the same
   oversized L2 upload this procedure exists to avoid.  Compare the printed `modtime` against
   the run you expect, not just the age.

2. **Is the snapshot the size you expect?**  The floor is 100 MB and the real snapshot is
   ~4.5 GB, so a badly truncated snapshot passes the guard - and the boundary is taken from
   the object's *filename*, which stays authoritative-looking regardless of content.  Compare
   the newest snapshot's size against the previous one and stop on any material regression.
   Deleting L1 through the boundary of a truncated snapshot can leave the supposedly
   superseded transactions with no valid restore source.

3. **Is the KEPT chain contiguous all the way through?**  The script checks only that the
   *first* kept object reaches the boundary; it does not walk the rest for internal gaps.
   L1 holes are a demonstrated production wedge, not a theoretical one - see
   `docs/rollouts/2026-08-22-litestream-l2l3-unwedge.md`, where Litestream refused L1 with
   `non-contiguous transaction ids in input files` and four holes across 560 objects.  The
   trim does not *create* such a hole (it only deletes at or below the boundary), but it will
   report success while L2 stays wedged and keeps burning the shared allowance.
   `scripts/litestream-l1-suffix-heal.py`'s dry run prints hole and twin counts for exactly
   this - use it as the gap detector before applying.

After `--apply`, confirm the fix landed rather than assuming: look for
`msg="compaction complete" ... level=2` and for the L2 object's `<min>` TXID advancing.  An
exit code of 0 means "objects were deleted", not "compaction recovered".

### The deliberate trade-off

Trimming L1 below a snapshot **reduces sub-daily point-in-time granularity for the trimmed
span** to whatever L0 still covers.  You can still restore to the snapshot, and to any point
after the trim boundary; you lose the ability to land between two arbitrary mid-day
transactions inside the span the snapshot already subsumes.

That is why this is an **on-demand heal and not a permanent nightly timer**.  The app's
configured snapshot retention (168h) stays the authoritative retention policy; this tool
must never quietly become a second, shorter one.  Arm it as a one-shot when L2 is wedged,
confirm L2 completed, and let it lapse.

### `boundary-trim` vs `suffix-heal` - which one

| | `litestream-l1-boundary-trim.py` | `litestream-l1-suffix-heal.py` |
|---|---|---|
| Keeps | everything above the newest snapshot's `maxTXID` | the newest `--keep-l1` contiguous L1 objects |
| Deletes | superseded L1 only | older L1 **plus all L2 and L3** |
| Restore hole | refuses to create one | **possible** if `--keep-l1` is chosen carelessly |
| Credentials | host `rclone` `[b2]` remote | `B2_KEY_ID` / `B2_APPLICATION_KEY` in env |

Prefer **boundary-trim** by default: it is keyed to something real (a snapshot that provably
contains the transactions being dropped) and it refuses to leave a gap.  Reach for
**suffix-heal** when the L2/L3 objects themselves are the problem - a poisoned or half-written
L2 that Compact keeps trying to extend - since boundary-trim never touches L2/L3.  When you
do use suffix-heal, read its dry-run hole/twin counts before applying and keep the default
`--keep-l1` unless you have a reason.

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
