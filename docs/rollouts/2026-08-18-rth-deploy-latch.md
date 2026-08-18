# 2026-08-18 — Coolify auto-deploy only in non-RTH + skip docs-only rebuilds

## Context & Objective

Jay believed Coolify already refused production deploys during regular US equity
hours.  It did not.  Since 2026-07-10 every push to `main` has auto-deployed
immediately, including market hours (`docs/rollouts/2026-07-10-auto-deploy-on.md`
said so explicitly).  The blind-spots audit (`docs/audits/2026-08-17-blind-spots.md`
F-OPS-1) recorded the same gap.

ASC then produced tonight's outage: **socratictrade.com was 503 ~7:15–7:49pm CT
(~34 minutes)** because Coolify **stop-old-then-start** ran a full image rebuild
for docs-only **#2811** (`23412aff`).  Cloudflare `no available server`.
`last_restart_at` null (the named container was gone; Traefik had no backend).
The app uses a consistent container name and no rolling flag — that is the
no-dual-Litestream-writer intent.  **Keep that.**  Do not bounce the live box.
Do not `FORCE_RESTORE`.  Do not PATCH live Coolify from this agent.

This PR implements the RTH latch **and** refuses docs-only / image-noop
rebuilds so a markdown merge cannot take origin down for the Horizon build
budget again.

## Tonight's 503 (#2811)

| Fact | Value |
|---|---|
| Window | ~7:15–7:49pm CT 2026-08-17 (merge `2026-08-18T00:43:40Z`) |
| Symptom | Cloudflare `no available server` (origin 503) |
| Sha | `23412aff` — docs-only #2811 |
| Files | `PLAN.md`, `STATUS.md`, `docs/EFFORT-LOG.md`, `docs/audits/…`, `docs/phase-7-strategy.md`, `docs/rollouts/…` |
| In the image? | Almost none.  `.dockerignore` drops `docs/**` except `docs/benchmarks`.  Root markdown is unused at runtime. |
| Deploy shape | Consistent container name, rolling **off**, stop-old-then-start |
| `last_restart_at` | null — process never came up as a successor; the old container was removed first |

Stop-old-then-start with a consistent name is correct for **one Litestream
writer**.  Rolling / zero-downtime would run two writers on one B2 prefix and
re-wedge L2.  The bug is the **order**: Coolify removed the named container
**before** the new image existed, so Traefik had nothing for the entire
`npm ci` + `next build` (~30 min Horizon budget).

Acceptable stop-old-first path (still one writer, still consistent name):

1. **Skip** the deploy when the commit cannot change the runtime image
   (implemented in-repo).
2. For a real runtime commit: **build the new image while the old named
   container keeps serving**, then stop the old container, then start the
   new one.  Traefik gap is the start period (~60–90s), not 34 minutes.
   Overlapping Traefik backends would require two containers; two
   `DB_BOOTSTRAP=live` containers are two Litestream writers.  We will not
   do that.

Owner Coolify UI (do **not** apply from this agent): confirm the recreate
does not delete the named container until the new image tag exists.  Optional
follow-up: disable `is_auto_deploy_enabled` and let workflow `RTH Deploy
Latch` be the only nudge, so a docs-only webhook never starts a deploy.

## Changes Made

No prior latch existed.  The GitHub webhook to
`https://host.jays.services/webhooks/source/github/events/manual` is still
the deploy trigger (hook id `662359267` at investigation time).

The Dockerfile now runs `tsx scripts/assert-rth-deploy-latch.ts` **before
`npm ci`**:

- Exit 2 during weekday RTH unless `HOTFIX=1` (env or commit token) or
  `RTH_DEPLOY_OVERRIDE=1`.
- Exit 3 when every changed path is image-noop (docs-only / dockerignored
  trees).  `docs/benchmarks/**` is image-relevant and still deploys.
- Exit 0 otherwise (evenings, weekends, holidays, early-close afternoon,
  runtime diffs).

A refused build must keep the last healthy named container.  The check is
**not** in `scripts/coolify-prod-start.sh`.

- `src/lib/deploy-image-impact.ts`
- `src/lib/rth-deploy-latch.ts`
- `scripts/assert-rth-deploy-latch.ts`
- `scripts/rth-deploy-drain.sh` (skips image-noop pending diffs)
- `test/rth-deploy-latch.test.ts`
- `Dockerfile` (latch before `npm ci`)
- `.github/workflows/rth-deploy-latch.yml`
- `.github/workflows/sentry-ci-report.yml`
- `scripts/sentry-ci-report.py`
- `docs/deployment.md`
- `docs/rollouts/2026-07-10-auto-deploy-on.md` (supersede pointer)
- `AGENTS.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- this note

## Decisions & Trade-offs

- **Build-time fail, not webhook disable.**  Turning off Coolify auto-deploy
  would require a box/DB flip.  This agent does not PATCH live Coolify.
- **Image-noop skip beats HOTFIX=1.**  A hotfix token on a markdown commit
  must not recreate the named container.  Touch a runtime file to force a
  rebuild.
- **Skip needs a file list.**  Prefer `CHANGED_FILES`.  Coolify builds
  pass `SOURCE_COMMIT` / `COOLIFY_COMMIT_SHA` and the latch fetches the
  public GitHub commit files.  A failed or truncated (>=300 files) fetch
  is treated as image-relevant (fail closed for skip).  `.git` stays
  dockerignored, so the image build cannot `git diff`.
- **No rolling / no zero-downtime flag.**  Two Litestream writers are the
  L2 wedge RCA.  Consistent container name stays.
- **No `FORCE_RESTORE`.**  A docs-only 503 is not a replica-restore event.
- **Did not bounce the live box.**
- **Did not steal #2792 / #2798 / #2800 / #2794.**
- Drain redeliver may 403 on `GITHUB_TOKEN`.  Fail-soft.

## Verification State

```bash
./node_modules/.bin/tsc --noEmit
npm run lint
./node_modules/.bin/vitest run test/rth-deploy-latch.test.ts \
  test/sentry-ci-report-workflows.test.ts test/market-hours.test.ts
```

tsc clean.  lint 0 errors (grandfathered warnings).  58 focused tests passed
(3 files).  Prior `verify-hosted` on this branch was green before the
image-noop follow-up (run `32087609316`).  Re-run after this push.

## Next Steps & Blockers

- Merge this PR outside weekday RTH (or the latch's own first image must
  build once).  After it is live, later RTH / docs-only builds refuse fast.
- Owner: confirm Coolify builds the new image **before** deleting the named
  container.  This agent will not flip that.
- Optional: `COOLIFY_DEPLOY_WEBHOOK_URL` if hook redeliver stays forbidden.

## Zero-Code Findings

- #2811 files are exactly the CI docs-only class and the image-noop class.
- Repo hook still POSTs every `push` to Coolify with no path filter.
- `scripts/coolify-prod-start.sh` has no market-hours gate and must not gain
  one (runtime refusal after swap = another 503).
