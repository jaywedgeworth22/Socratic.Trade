# Kimi fleet audit D/E/F — Robinhood peer path, CI hygiene, required pin-check

## 1. Context & Objective

Jay's decisions from the Kimi fleet audit: keep CT peer quotes working, tighten CI install/pinning, and make shared-package pin-check required without deadlocking auto-merge.

## 2. Changes Made

- `src/lib/market-realtime.ts` — dropped the live `ROBINHOOD_MCP_AUTH_TOKEN` gate. Operator Robinhood for CT **intraday** only, via `operatorPeerRead` + stored `local` token.
- `app/api/market/intraday/[symbol]/route.ts` — passes `operatorPeerRead: true` after `APP_B_INGEST_TOKEN`.
- `app/api/market/quotes/route.ts` — comment that live quotes stay Alpaca/Yahoo.
- `src/lib/robinhood.ts` — comments no longer claim an env bypass of `getMcpAccessToken`.
- `test/market-realtime.test.ts`, `test/market-intraday-route.test.ts`
- `.github/workflows/ci.yml`, `e2e.yml` — `npm ci` on the verify/smoke install path; cache keys use `package-lock.json`.
- `.github/workflows/cleanup-caches.yml` — gh CLI 2.98.0 SHA256-pinned (no `/releases/latest`).
- `.github/dependabot.yml` — `github-actions` ecosystem (npm kept; no bundler ecosystem existed).
- `package.json` / `package-lock.json` — pin `@jaywedgeworth22/congress-trading-shared` to commit `b2847eb9b7839ad1241ee455a688ef0eec4ccdd6` (same commit as tag `v2.5.2`); lock `resolved` is `git+https`.
- `.github/workflows/shared-package-pin-check.yml` — require a 40-char SHA pin; compare CT vendor copy when npm dep is absent; `merge_group`; required-check comment.
- `scripts/check-shared-package-pin.sh` — local SHA/lock assertion.
- Docs: `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this rollout.

## 3. Decisions & Trade-offs

- **Would removing the global RH bypass break CT quotes?** Live `/api/market/quotes` never used Robinhood, so no. **Intraday would degrade or go unavailable** (Alpaca 1m IEX fallback, and no credential => 502). Jay: if it would interfere, do not remove — narrow it. Bound to the ingest-token peer intraday route; env var is boot-seed only.
- Did not mint a separate peer RH token (Infisical sibling owns secrets). Operator stored OAuth/`local` row is the credential.
- Did not fail-closed pin-check when `GH_PACKAGES_TOKEN` is missing (would break auto-merge). Local SHA pin still fails the job. Peer compare uses CT `app/vendor` 2.5.2 when npm dep is gone.
- Did not add a human review gate or staging app.

## 4. Verification State

```bash
python3 -c "import yaml,sys; [yaml.safe_load(open(p)) for p in sys.argv[1:]]" \
  .github/workflows/ci.yml .github/workflows/e2e.yml \
  .github/workflows/cleanup-caches.yml .github/workflows/shared-package-pin-check.yml \
  .github/dependabot.yml
bash scripts/check-shared-package-pin.sh
npx vitest run test/market-realtime.test.ts test/market-intraday-route.test.ts
```

## 5. Next Steps & Blockers

- Restore `check-pin` on ruleset `main-protection` (https://github.com/jaywedgeworth22/Socratic.Trade/rules/17945518) once this PR's check-pin run is green.
- `GH_PACKAGES_TOKEN` still skip-passes the peer half if unset.

## 6. Zero-Code Findings

- `getMcpAccessToken` already had no env bypass (`migrateLocalRobinhoodToken` seeds `local` at boot).
- CT `app/package.json` no longer lists the npm shared dep; vendor `app/vendor/congress-trading-shared` is 2.5.2, which is why the old pin-check was a no-op.
