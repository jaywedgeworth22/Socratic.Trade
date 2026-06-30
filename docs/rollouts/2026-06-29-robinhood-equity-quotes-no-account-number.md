# 2026-06-29 — Robinhood MCP get_equity_quotes: drop account_number

## Summary
- `HttpMcpRobinhoodGateway.getEquityQuotes` now calls `get_equity_quotes` with `{ symbols }` only.
- Removed `account_number` from the MCP tool arguments (Robinhood schema rejects it).

## Why
- Prod ops snapshot showed `recoverable_issue` on every Agentic (Robinhood) strategy run:
  `unexpected additional properties ["account_number"]` on `get_equity_quotes`.
- Quotes returned `{}`, contributing to `Evaluated 0 proposal(s)` on scheduled runs.
- Existing unit test already called `callRobinhoodMcpTool(..., { symbols })` without `account_number`; gateway was out of sync.

## Files
- `src/lib/robinhood.ts`
- `test/robinhood-mcp.test.ts`
- `STATUS.md`, `docs/rollouts/2026-06-29-robinhood-equity-quotes-no-account-number.md`

## Verification
- `npx vitest run test/robinhood-mcp.test.ts` — 9 passed
- `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` — run before merge

## Follow-ups
- Deploy + restart `trading`; confirm Agentic runs show quotes and non-zero evaluations.
- After PR #255 deploy: re-Start halted Alpaca accounts and verify per-account credentials.

## 2026-06-30 PR #256 Review Follow-up

### Summary
- Resolved the remaining review blocker by keeping `next-env.d.ts` on the production build-generated `./.next/types/routes.d.ts` import.

### Why
- The branch had committed the dev-server route-types path, which `npm run build` rewrites and would leave clean-tree workflows dirty after verification.

### Files
- `next-env.d.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-06-29-robinhood-equity-quotes-no-account-number.md`

### Verification
- Initial `npm run lint` failed before linting with `eslint: command not found`
  because this PR worktree's dependency tree was incomplete.
- `npm ci` failed while repairing the stale dependency tree with npm/macOS
  `ENOTEMPTY` under `node_modules/next`; `npm install --no-audit --no-fund`
  repaired the local dependency tree without tracked dependency-file changes.
- `npm run lint` - passed with 0 errors and existing warnings.
- `npx tsc --noEmit` - passed.
- `npm test` - failed one existing timeout:
  `test/strategy-tuning.test.ts` manual-review fallback exceeded 20 seconds;
  158 files / 1537 tests passed before the timeout.
- `npm test -- --testTimeout=40000` - passed, 159 files / 1538 tests.
- `npm run build` - passed; `next-env.d.ts` remained on
  `./.next/types/routes.d.ts`.
