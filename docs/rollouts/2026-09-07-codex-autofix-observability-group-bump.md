# 2026-09-07 — Codex-autofix handoff records for observability group bump (PR #3178)

## Summary

Dependabot bumped the `observability` dependency group (PR #3178, commit `437e08531`):  `@opentelemetry/instrumentation` 0.221.0 → 0.222.0, `@opentelemetry/sdk-trace-node` 2.10.0 → 2.11.0, `@sentry/nextjs` 10.71.0 → 10.73.0, `@sentry/profiling-node` 10.71.0 → 10.73.0 (plus transitive lockfile updates, 7 updates total per Dependabot).  Codex flagged the bump as missing the repo's mandatory handoff records (STATUS.md + docs/EFFORT-LOG.md) before landing.  This codex-autofix round adds those records so the repository snapshot and cross-agent ledger reflect the dependency upgrade.  No runtime code changed.

## Why

The repo handoff protocol (AGENTS.md) requires STATUS.md and docs/EFFORT-LOG.md updates before a change lands on main, and the merge gate requires every Codex review thread to be resolved.  A Dependabot bump cannot write those records itself, so the codex-autofix lane adds them for PR #3178 — the same pattern already used for PR #3177 (`docs/rollouts/2026-09-07-codex-autofix-next-react-16-3-4.md`).

## Files

- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-09-07-codex-autofix-observability-group-bump.md`
- `package.json` / `package-lock.json` (the dependabot commit `437e08531` itself)

## Verification

- `npx tsc --noEmit`
- `npm test`
- `npm run build`

## Follow-ups

- Auto-merge (squash) lands PR #3178 once the required checks pass and the Codex thread is resolved.  No further code action expected.
