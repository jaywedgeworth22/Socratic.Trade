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
