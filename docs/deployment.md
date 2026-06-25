# Production Deployment

Production is the self-hosted PM2 site at **trading.jays.services**, served by
`next start` (PM2 app `trading`) from the `~/apps/trading-live` worktree on the
owner's Apple Silicon Mac.

The pre-production beta route is **trading-beta.jays.services**, served by
`next dev` (PM2 app `trading-main`) from the editable integration checkout
`~/Code/Agentic Trading` on port `4001`. Production remains isolated on port
`4000`; beta should never point at an agent worktree such as `trading-claude`.

Cloudflare DNS, Tunnel ingress, Access apps, redirect-rule exclusions, and
documentation should use `trading-beta.jays.services` for the 4001 beta lane.
Do not create a second dev/beta hostname for this preview.

## Configuration & secrets (`.env.local`) — what's authoritative

`.env.local` is **git-ignored** (`.gitignore`: `.env`, `.env*.local`) and is
**never committed** — only the secret-free template `.env.example` is tracked.
Git is therefore **not** the source of truth for secret *values*, and there is
no single canonical `.env.local` file: each machine/worktree has its own
independent copy that does not sync with the others.

**The authoritative upstream for secret values is Google Cloud Secret Manager.**
Every `.env.local` is a local materialization (cache) of what lives in GCP. To
change a secret, update it in GCP (add a new secret version) — that is the
canonical edit; the `.env.local` copies are downstream of it.

The repo also ships an Infisical delivery path (`*:secrets` /
`scripts/infisical-run.mjs`, which just runs `infisical run -- …`). With GCP
designated canonical, treat the Infisical path as **legacy**: there is **no
GCP→Infisical sync**, so `*:secrets` serves whatever is stored in Infisical and
goes **stale** after a GCP-only rotation. Prefer the `*:gcp` wrappers; only use
`*:secrets` if you keep its Infisical store mirrored from GCP.
(`docs/ops-observability-security.md` defers to GCP.)

Run with secrets pulled live from GCP at runtime via the `*:gcp` scripts
(`scripts/gcp-secrets-run.mjs`):

```bash
npm run dev:gcp      # next dev   with GCP secrets injected
npm run build:gcp    # next build with GCP secrets injected
npm run start:gcp    # next start with GCP secrets injected
```

- **Auth — must be *exported*, not in `.env.local`:** set `GCP_PROJECT_ID` (or
  `GOOGLE_CLOUD_PROJECT`) and provide Application Default Credentials —
  `GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json`,
  `gcloud auth application-default login` (local dev), or Workload Identity
  (GCP-hosted). The wrapper reads these from its **own `process.env` before
  spawning Next** and never parses `.env.local` (and `npm`/PM2 don't load
  `.env.local` for it either), so set them in the shell/PM2/runner environment.
  If `GCP_PROJECT_ID` isn't exported, the wrapper silently takes the no-project
  fallback (plain run, no GCP secrets).
- **Mapping & scoping:** each GCP secret whose name equals an env-var name is
  injected under that name (secret `INTRINIO_API_KEY` → env `INTRINIO_API_KEY`).
  Scope which secrets load with `GCP_SECRET_NAMES=A,B,C` (explicit list) or
  `GCP_SECRETS_PREFIX=trading-` (prefix filter — the prefix is stripped to form
  the env name). **On a shared (non-dedicated) GCP project, set one of these** —
  with neither set, the runner lists and injects *every* secret in the project
  and logs each name at startup.
- **Overwrite precedence:** by default GCP does **not** overwrite a variable
  already present in the wrapper's **exported** environment (shell/PM2 env); set
  `GCP_SECRETS_OVERWRITE=true` to override those too. This applies to *exported*
  env vars only — a value that lives solely in a `.env.local` file is read by Next
  *after* the wrapper has injected GCP's value into `process.env`, so the GCP
  value wins regardless. To keep a local override under a `*:gcp` wrapper, export
  it (or use the plain scripts).
- **Fails open (mostly) — check the logs:** if Secret Manager is unreachable at
  the API level (IAM/permission/network) the wrapper logs `Falling back to
  running command without GCP secrets` and starts the app with the **existing**
  environment; per-secret fetch errors are warnings only. A clean start is
  therefore **not** proof that live GCP values loaded — after a rotation a restart
  can silently keep serving stale `.env.local`/exported values. Check the
  `[gcp-secrets]` startup logs. (Exception: a missing/invalid
  `GOOGLE_APPLICATION_CREDENTIALS` *file path* currently throws uncaught and exits
  non-zero rather than failing open — a separate hardening follow-up.)
- **When GCP is not configured.** If `GCP_PROJECT_ID` is unset the runner skips
  Secret Manager and runs the command directly. This path now **waits for the
  child and propagates its exit code**, same as the configured path (a fixed bug
  — it previously called `process.exit(0)` right after spawning, so `build:gcp`
  could report success before `next build` finished and let a chained
  restart/deploy run against an unfinished build). Either way, the plain
  `npm run dev`/`build`/`start` remain the simplest choice when GCP isn't
  configured.

**How each `.env.local` relates (none is canonical over GCP):**

| Location | Role | How to refresh |
|---|---|---|
| `~/Code/Agentic Trading/.env.local` | Integration/dev **seed**. `scripts/setup-agent-previews.sh` copies it into a new agent worktree **once, only if absent**. | Change shared secrets in **GCP** (canonical). A direct edit here is a local-only override — it won't reach GCP, production, or already-seeded agent worktrees, and after a GCP rotation this file keeps seeding **stale** values into new worktrees until you update it. |
| `~/apps/trading-<agent>/.env.local` | Per-agent preview copy; **diverges** after the one-time seed (editing one never updates the others). | Delete + re-run `setup-agent-previews.sh` to re-seed, or run via `dev:gcp`. |
| `~/apps/trading-live/.env.local` | **Production.** Preserved across deploys — `git reset --hard FETCH_HEAD` only touches *tracked* files. | Run PM2 `trading` under `start:gcp` to inject live GCP values at boot (host PM2 wiring lives in `~/apps/README.md`). The wrapper doesn't rewrite the file; don't hand-edit it and let it drift from GCP. |

> Note: the `*:gcp` wrappers inject secrets into the spawned **process** only —
> there is no step that writes GCP values back into any `.env.local` file. After a
> rotation, run services under the wrapper to pick up new values; on-disk
> `.env.local` files keep their last-written contents until you edit them.

Per-user secrets entered through the app's Settings are **not** in `.env.local`
— they are AES-256-GCM encrypted (under `ENCRYPTION_KEY`) in SQLite: provider API
keys in `user_api_keys`, and broker `api_key`/`api_secret` in `connected_accounts`
(`upsertConnectedAccount`/`getActiveConnectedAccount`, `db-api-keys.ts`).
Backup/rotation/deletion runbooks must cover **both** tables. Beyond
operator/primary-user **provider fallback keys**, `.env.local` (or the exported
runtime env) also carries **bootstrap/infra secrets** that are not per-user —
notably the **`ENCRYPTION_KEY`** that decrypts `user_api_keys` (it MUST stay
stable: if it changes or is unset, a random key is generated per process and
every stored key becomes undecryptable after a restart — see `.env.example`),
plus auth/webhook tokens, backup credentials, and provider toggles. These can
live in GCP and reach the **app** via the `*:gcp` wrappers — but rotate each on
the path the process that reads it actually uses. In particular, the Litestream
backup sidecar (`scripts/run-litestream.sh` / `litestream-restore.sh`) reads
`LITESTREAM_*` from the live `~/apps/trading-live/.env.local` (or the exported
env), **not** through the app's `*:gcp` wrapper, so rotate its R2 credentials
there (or wrap that sidecar separately).

> Status: the `*:gcp` runner exists and is the **designated** source of truth,
> but it requires `GCP_PROJECT_ID` + ADC configured on each box, and production
> auto-pull (PM2 `trading` via `start:gcp`) must be wired into the host PM2
> ecosystem before live deploys read from GCP. See
> `docs/rollouts/2026-06-24-intrinio-tiingo-twelvedata-gcp-secrets.md`.

## How it deploys (automated)

`.github/workflows/deploy.yml` deploys on **every push to `main`** (i.e. every
merged PR) and via a manual **Actions → Deploy → Run workflow** button. The job
runs on the self-hosted runner labeled `trading-live` and, in `~/apps/trading-live`:

```
git fetch https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git main
git reset --hard FETCH_HEAD
npm ci
npm run build
pm2 restart trading --update-env
pm2 save
```

- A `deploy-production` concurrency group prevents overlapping deploys.
- Only **tracked** files are reset, so `.env.local`, `data/app.db`, and
  `data/logos/` on the box are preserved.
- Auth uses the job's `GITHUB_TOKEN` (the headless launchd runner has no git
  creds); it resets to `FETCH_HEAD` rather than checking out `main` because
  `trading-live` is a linked worktree that can't share the `main` checkout held
  by the integration worktree. See
  `docs/rollouts/2026-06-22-deploy-workflow-activated.md` for the why.

## Preview lane sync

`.github/workflows/sync-previews.yml` runs on the same self-hosted Mac after
every push to `main` and calls `scripts/sync-preview-lanes.sh`.

The sync updates only local preview lanes:

- `trading-beta.jays.services` / PM2 `trading-main` / port `4001`
- `claude.jays.services` / PM2 `trading-claude` / port `4100`
- `codex.jays.services` / PM2 `trading-codex` / port `4101`
- `antigravity.jays.services` / PM2 `trading-antigravity` / port `4102`

Production remains owned by the Deploy workflow. Preview sync skips dirty
worktrees, unexpected branches, and merge conflicts. If a lane advances but
fails local `/api/health` or root-page checks, the script rolls that lane back
to its previous commit and restarts the PM2 app.

Optional PM2 polling fallback:

```bash
pm2 start ~/Code/Agentic\ Trading/scripts/sync-watchdog.sh --name trading-sync-watchdog
pm2 save
```

## Runner

A GitHub Actions self-hosted runner registered on the Mac:
`~/actions-runner`, labels `self-hosted,trading-live`, installed as a LaunchAgent
(`./svc.sh install && ./svc.sh start`, **no sudo** on macOS). Setup details and
the SSH-from-hosted-runner alternative live in `ci-pending/README.md`.

Optional repo **Variables** `DEPLOY_DIR` / `PM2_APP` override the defaults
(`$HOME/apps/trading-live`, `trading`).

## Manual deploy (fallback)

If the runner is down, deploy by hand on the box:

```bash
cd ~/apps/trading-live
git fetch origin main && git reset --hard origin/main
npm ci && npm run build
pm2 restart trading && pm2 save
```

## Verifying a deploy

- Actions → Deploy → latest run is green.
- `curl -I https://trading.jays.services/` returns a response (a `302` to the
  auth gate is expected for an unauthenticated request — it means the app is up).
- `curl -I https://trading-beta.jays.services/` should reach the beta Access app
  and then the `trading-main` tunnel service on `http://localhost:4001`.
- Access requires the visitor's email to be on the allowlist
  (`PRIMARY_USER_EMAIL` / `ADMIN_USER_EMAILS`, or the Cloudflare Access policy);
  otherwise the app shows **Access denied** by design.
