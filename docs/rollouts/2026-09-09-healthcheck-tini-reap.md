# 2026-09-09 — Docker HEALTHCHECK tini PID1 + curl self-timeout

## Context & Objective

Public `socratictrade.com` returned Traefik 503 `no available server` in ~2h flaps (13:51Z, 16:03Z, 18:07Z) while the Node process was often still answering in-container.  Docker HEALTHCHECK `curl /api/live` SIGKILL'd hung probes.  `infisical-run` (Node) is PID1 and does not `wait()` those children, so zombie curls piled up (CPU 105%, FailingStreak, Traefik dropped the backend).  Recurred 2026-09-10 during RTH; Sentry SOCRATIC-TRADE-S/2D auto-resolved after an existing-container docker-restart.  Board `e7b49943`.  SOCRATIC-TRADE-S / 2D / 4 (scheduler-tick) are companions of the same hang.

## Changes Made

- Runtime image installs `tini` and uses `ENTRYPOINT ["tini", "--"]` so HEALTHCHECK children are reaped.
- HEALTHCHECK still probes `GET /api/live` (never `/api/health`).  Rebase onto main keeps `--timeout=15s --retries=5` (PR #3201) and adds `curl --max-time 14 --connect-timeout 2` so curl exits itself before Docker's 15s kill.

Touched files:

- `Dockerfile`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-09-09-healthcheck-tini-reap.md`

## Decisions & Trade-offs

Did not Coolify Deploy during RTH (Dockerfile is an image build; latch would refuse after stop-old-first).  Did not bounce prod.  Did not change Coolify HTTP health.  The event-loop hang itself is PR #3202 (FTS mirror non-convergence).  After cash close, Deployer can image-deploy main (this tini ENTRYPOINT plus whatever is already on main).  Do not arm auto-merge while RTH is in effect.

## Verification State

Dockerfile-only.  Do not run a weekday image build.  Public restore is existing-container `docker restart` by BF-DEPLOYER.
