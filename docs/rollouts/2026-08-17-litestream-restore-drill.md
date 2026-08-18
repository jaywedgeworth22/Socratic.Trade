# 2026-08-17 — Litestream restore drill (scratch only)

## Context & Objective

`docs/litestream.md` still recorded restore as unexercised (G9a, 2026-07-01).  ASC ran a scratch-only B2 restore on `fleet-hetzner-nbg1` on 2026-08-18 UTC and handed the receipts to this note.  Goal: write the audit trail so the next operator can see what is VERIFIED, BLOCKED, and NOT VERIFIED.  This PR is report-only.  No product code.  No live Coolify writes.  No bounce.  No `FORCE_RESTORE`.  No Mac pm2.  Live volume untouched.  Live stayed HTTP 200.

## Changes Made

Docs only.  The restore already happened on the host.  This note records it.

Touched files:

- `docs/rollouts/2026-08-17-litestream-restore-drill.md` (this note)
- `docs/litestream.md` (restore verification status + B2-proven pointer)
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Scratch paths only.  Live `/app/data/app.db` was not overwritten.
- Creds came from the running Socratic Litestream process env.  The env file was shredded after.  No Infisical dump in this PR.
- Auto-review blocked reading `ENCRYPTION_KEY` and writing ciphertext off the host.  Credential last-4 stays BLOCKED pending owner approval.
- Do not add Coolify rolling or zero-downtime.  The live app is already stop-old-then-start (`is_consistent_container_name_enabled=true`, dockerfile pack).  A separate docs-deploy 503 after #2810/#2811 is recorded below and is not part of the restore proof.
- `R2_ARCHIVE_KEEP_GENERATIONS` is a live process env name, not a repo knob.  Code default for weekly retain is `R2_COLD_SNAPSHOT_DEFAULT_RETAIN=1`.  This drill does not change either.

## Verification State

ASC / host findings (2026-08-18 UTC).  No bounce.  No `FORCE_RESTORE`.  No Mac pm2.  Live volume untouched.  Live stayed HTTP 200.

### VERIFIED — B2 restore to scratch

- Host: `fleet-hetzner-nbg1` via `ssh coolify`
- Command: `litestream restore -config /data/scratch/socratic-restore-20260818/litestream.coolify.yml -o /data/scratch/socratic-restore-20260818/app.db /app/data/app.db`
- Started 2026-08-18T01:12:26Z, file complete ~01:14Z, 4.9G
- Replica: B2 (`litestream.coolify.yml` path `trading-live/app.db`).  Creds from running socratic litestream process env; env file shredded after.
- Second scratch also at `/data/backups/restore-proof/socratic-restore-scratch-20260817/app.db` (another restore ASC did not start).  Both scratch.

### VERIFIED — PRAGMA integrity_check (scratch)

- sqlite3 3.46.1 → `ok`.  ~4m (01:16:30Z–01:20:38Z)

### VERIFIED — max(audit_events.created_at) vs live

- Live (read-only node sqlite on container, ~01:11Z): max 2026-08-18T01:11:22.198Z, n=210000
- Scratch: max 2026-08-18T01:12:10.915Z, n=210008
- Delta: scratch ~48s newer than that live sample / within seconds of restore start.  RPO looks healthy.

### BLOCKED — decrypt one stored credential

- Auto-review blocked reading `ENCRYPTION_KEY` / writing ciphertext off the host.
- Metadata only: `connected_accounts` rows exist (alpaca paper/live, tradier live/paper).  `api_key` length 110–114, `api_secret` 146 or empty.  Envelope is NOT `v1:` (legacy bare `iv:tag:cipher` per `decryptValue`).  Needs owner approval to decrypt last-4.

### VERIFIED — no dual Socratic Litestream writers

- Three replicate PIDs, three apps: socratic `4806ba4f` (`litestream.coolify.yml` + next start, started 00:49Z), congress `d7e8f6e0` (deno), usage `83555eddd`.
- One socratic container.  Coolify: `is_consistent_container_name_enabled=true`, dockerfile pack, no rolling/zero-downtime.  Stop-old-then-start.

### VERIFIED — host 6h local sqlite backups

- `/data/backups/socratic/socratic-app-{20260817T121501Z,20260817T181501Z,20260818T001501Z}.db` (+ sha256)
- Latest 4.9G.  `PRAGMA integrity_check` ok.  max(audit_events)=2026-08-18T00:18:08.117Z n=212967 (older max, higher count than current — consistent with later pruning + new events).

### NOT VERIFIED as retain=1 — R2 weekly

- Health `r2Weekly` ok, key=`cold-snapshots/app-2026-08-16.db`
- Process env `R2_ARCHIVE_KEEP_GENERATIONS=2` (not 1).  Objects not deleted.

### Out of scope — Coolify 503 after docs deploys

Separate Coolify 503 ~00:15–00:49Z after docs deploys #2810/#2811 (stop-old-first, Cloudflare no available server).  Recovered sha `23412aff`.  That is not part of the restore proof.

```
# docs-only; no product-code compile required
npx tsc --noEmit   # not required for this PR; skipped
npm test           # not required for this PR; skipped
npm run lint       # not required for this PR; skipped
npm run build      # not required for this PR; skipped
```

## Next Steps & Blockers

1. Owner: approve an on-host last-4 decrypt of one stored credential if that check still matters.  Do not copy `ENCRYPTION_KEY` or ciphertext off the host.
2. Owner: decide whether live `R2_ARCHIVE_KEEP_GENERATIONS=2` should become 1 (or `R2_COLD_SNAPSHOT_RETAIN=1`) and whether older `cold-snapshots/` objects should be deleted.  This drill did not delete objects.
3. Leave Coolify as stop-old-then-start.  Do not add rolling or zero-downtime.
4. Scratch files at `/data/scratch/socratic-restore-20260818/` and `/data/backups/restore-proof/socratic-restore-scratch-20260817/` can be shredded when the owner no longer wants the proof copies.
5. Repeat the scratch restore after any Litestream / `litestream.coolify.yml` version bump (quarterly otherwise).

## Zero-Code Findings

B2 restore to a host scratch path works.  The restored SQLite file is intact and its newest `audit_events` row is within seconds of restore start.  One Socratic Litestream writer is running.  Host 6h local backups are intact.  Decrypt of a stored broker credential was not done.  R2 weekly is healthy but is not proven as retain=1 (`R2_ARCHIVE_KEEP_GENERATIONS=2`, objects not deleted).  The ~00:15–00:49Z Coolify 503 after #2810/#2811 is a stop-old-first docs-deploy gap, not a restore failure.
