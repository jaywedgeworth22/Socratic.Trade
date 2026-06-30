# 2026-06-30 - Congress.Trade Shared Contract Package

## Summary

Integrated the private `@jaywedgeworth22/congress-trading-shared` package into Agentic Trading's Congress.Trade App A/B integration. The app now imports shared wire types, API path constants, and Zod schemas instead of keeping duplicated local definitions for transaction reads, outbound share payloads, and inbound event envelopes.

## Why

The two apps were carrying overlapping TypeScript contracts for the same cross-app API. Centralizing those contracts reduces schema drift and lets both sides share runtime validation. The first shared-package commit was not installable as a git dependency because its tarball contained only `package.json`; companion shared-package PR #1 adds `prepare`/build/publish metadata so git installs produce `dist`.

## Files

- `.github/workflows/ci.yml`
- `.github/workflows/e2e.yml`
- `.github/workflows/deploy.yml`
- `package.json`
- `package-lock.json`
- `src/lib/congress-score.ts`
- `src/lib/congress-share.ts`
- `src/lib/congress-shared-aliases.ts`
- `src/lib/congress-trade-client.ts`
- `src/lib/congress-trade-events.ts`
- `src/lib/web-sources/congress-analytics.ts`
- `src/lib/web-sources/congress.ts`
- `src/lib/web-sources/types.ts`
- `test/congress-analytics.test.ts`
- `PLAN.md`
- `STATUS.md`
- `docs/congress-trade-consume.md`
- `docs/congress-trade-share.md`
- `docs/rollouts/2026-06-30-congress-trading-shared.md`

## Decisions

- Pin the app dependency to shared-package commit `220677a3fb768c9e378404736e8f1f8c933220e1` until the package is published or a versioned release process is active.
- Keep private repo access narrow: set the shared repo's Actions access to `user`, and pass GitHub auth only as ephemeral `GIT_CONFIG_*` environment for `npm ci`.
- Remove unrelated PR drift from the app branch: page-title copy changes, `scripts/deploy.sh`, and the auto-deploy `AGENTS.md` block do not belong to this integration.

## Verification

- Shared package: `npm run typecheck`
- Shared package: `npm run build`
- Shared package: `npm audit --audit-level=moderate`
- Shared package: `npm run pack:dry`
- Shared package: `npm run publish:dry`
- App: `npm install --package-lock-only`
- App: workflow YAML parse check with Ruby `YAML.load_file`
- App: clean install using the same ephemeral private-git auth pattern as CI/deploy: `npm ci`
- App: `npm run lint` - passed with the existing warning backlog and 0 errors
- App: `npx tsc --noEmit` - passed
- App: `npm test` - 159 files / 1537 tests passed
- App: `npm run build` - passed; existing Next middleware-to-proxy deprecation warning only

## Follow-ups

- Merge/publish `jaywedgeworth22/congress-trading-shared#1`, then move Agentic Trading from a pinned git commit to a versioned GitHub Packages release if desired.
- Watch PR #251 CI to confirm the private git dependency auth path works on the self-hosted runner.
