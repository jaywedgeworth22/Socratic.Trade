# 2026-08-18 — Coolify auto-deploy only in non-RTH (`HOTFIX=1` escape)

## Context & Objective

Jay believed Coolify already refused production deploys during regular US equity
hours.  It did not.  Since 2026-07-10 every push to `main` has auto-deployed
immediately, including market hours (`docs/rollouts/2026-07-10-auto-deploy-on.md`
said so explicitly).  The blind-spots audit (`docs/audits/2026-08-17-blind-spots.md`
F-OPS-1) recorded the same gap.  This change implements a real weekday RTH
block with `HOTFIX=1` / explicit owner override, without taking the site down.

## Changes Made

No prior latch existed in workflows, Coolify hooks, or the start script.  The
GitHub webhook to `https://host.jays.services/webhooks/source/github/events/manual`
is still the deploy trigger (hook id `662359267` at investigation time).  The
block is a **Coolify image-build** refusal: `npx tsx scripts/assert-rth-deploy-latch.ts`
runs after `COPY . .` and before `npm run build`.  Exit 2 fails the new image
and Coolify keeps the last healthy container.  The check is deliberately **not**
in `scripts/coolify-prod-start.sh` — a runtime exit would take the site down
after the container swap.

RTH is `isMarketOpen()` from `src/lib/market-calendar.ts`: Mon–Fri 09:30–16:00
ET, 09:30–13:00 ET on NYSE early-close days, closed on weekends and full
holidays.  Pre-market, post-close, evenings, and weekends stay allowed.

Escapes:

- `HOTFIX=1` as a Coolify / Docker build-arg env, or a standalone `HOTFIX=1`
  token in the merge commit message (read from `COMMIT_MESSAGE` or the public
  GitHub commit API via `SOURCE_COMMIT`).
- `RTH_DEPLOY_OVERRIDE=1` for an explicit owner request that is not labeled a
  hotfix.

Workflow `RTH Deploy Latch` (not the retired `deploy.yml` / `Deploy` name)
comments on a blocked `main` push and, at 21:20 UTC weekdays, drains
`origin/main` if production is behind.  Drain nudges are fail-soft: redeliver
the Coolify GitHub webhook when the token can, else `COOLIFY_DEPLOY_WEBHOOK_URL`
if set, else wait for the next non-RTH push.

- `src/lib/rth-deploy-latch.ts`
- `scripts/assert-rth-deploy-latch.ts`
- `scripts/rth-deploy-drain.sh`
- `test/rth-deploy-latch.test.ts`
- `Dockerfile`
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
  would require a box/DB flip we cannot reach from this VM (Coolify API is
  Cloudflare-allowlisted).  Failing the image build is the block we can ship
  from the repo, and it does not take the site down.
- **Do not fail in `coolify-prod-start.sh`.**  Coolify may already have
  replaced the running container by then.
- **Did not recreate `deploy.yml` / workflow name `Deploy`.**  That was the
  retired Mac/PM2 publisher; `test/sentry-ci-report-workflows.test.ts` still
  forbids it.
- **Did not steal #2792 / #2798 / #2800 / #2794.**  FilingAPI, alert-noise,
  Pinecone daily-remainder, and iOS privacy/handoff stay on those PRs.
- **Did not trigger a production deploy from this session.**
- Holiday weekday 09:30–16:00 is already non-RTH via `isMarketOpen` (full
  close).  Early-close afternoons are allowed.
- Drain redeliver may 403 on `GITHUB_TOKEN` (hook write).  That is fail-soft;
  the latch still holds, and the next evening/weekend merge deploys HEAD.

## Verification State

Commands to run after the first push:

```bash
npx tsc --noEmit
npm run lint
npx vitest run test/rth-deploy-latch.test.ts test/sentry-ci-report-workflows.test.ts test/market-hours.test.ts
npm test
npm run build
```

Status recorded in the PR after the gate finishes.

## Next Steps & Blockers

- Merge outside weekday RTH, or squash with `HOTFIX=1` if this must land
  during the cash session (the latch's own first image must build successfully
  once so later RTH refusals use this Dockerfile).
- Optional owner secret: `COOLIFY_DEPLOY_WEBHOOK_URL` if hook redeliver stays
  forbidden to `GITHUB_TOKEN`.
- Optional Coolify build-arg: pass `SOURCE_COMMIT` so commit-message
  `HOTFIX=1` works even when `COMMIT_MESSAGE` is unset.  Public GitHub API is
  the fallback.

## Zero-Code Findings

Investigation (no latch on `main` before this PR):

- `.github/workflows/` had no deploy workflow (deleted 2026-07-11).
- Repo hook `662359267` POSTs every `push`/`pull_request` to Coolify's manual
  GitHub webhook.  No time filter.
- `scripts/coolify-prod-start.sh` has no market-hours gate.
- `docs/rollouts/2026-07-10-auto-deploy-on.md` stated "including market hours."
- Reserved PRs #2792 (FilingAPI keep), #2798 (alert noise), #2800 (Pinecone
  remainder), #2794 (iOS #2560) are unrelated and were left alone.
