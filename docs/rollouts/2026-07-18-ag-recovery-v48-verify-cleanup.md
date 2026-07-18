# 2026-07-18 — PR #1735 verify cleanup

## Summary

Merged `origin/main` into `agent/ag-recovery-v48-migration` and fixed the hosted `verify` failures
left on PR #1735.

## Why

The branch canonicalizes OpenRouter telemetry to bare model IDs for usage and benchmark persistence,
but four existing tests still expected provider-qualified served-model attribution such as
`openai/gpt-4.1-mini` and `google/gemini-2.5-flash`. GitHub Actions failed on those assertions.

## Files

- `test/llm-provider-cooldown.test.ts`
- `test/strategy-llm-failover.test.ts`
- `test/persistence-notification.test.ts`
- `test/strategy-money-path-f-g.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`

## Verification

Passed:

```bash
npm test -- test/llm-provider-cooldown.test.ts test/strategy-llm-failover.test.ts test/persistence-notification.test.ts test/strategy-money-path-f-g.test.ts
```

Result: 4 files passed, 34 tests passed.

## Follow-ups

Let PR #1735 hosted `verify` rerun on the pushed branch and use the full gate as the merge arbiter.

## Round 2 review cleanup

Resolved two fresh Codex review comments on PR #1735:

- Preserved `companyName` display casing in `src/lib/db-securities-import.ts`; ticker normalization
  remains uppercase, but imported names such as `Tesla` no longer pass through the ticker-oriented
  shared `clean()` helper.
- Regenerated `package-lock.json` with `npm install --package-lock-only --ignore-scripts --no-audit
  --no-fund`, restoring the peer dependency entries needed by `@langfuse/otel` and webpack so clean
  installs no longer re-resolve/fail on missing lock entries.

Additional verification:

```bash
npm ci --dry-run --ignore-scripts
npm ci --no-audit --no-fund
npm test -- test/securities-import.test.ts
```

Result: clean-install dry-run passed; focused securities import suite passed, 17/17 tests.
