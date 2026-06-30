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
- `npm ci` - first attempt failed with a transient missing private package directory during extraction; `rm -rf node_modules && npm ci --prefer-online` passed.
- `npm run lint` - passed with 0 errors and 257 existing warnings.
- `npx tsc --noEmit` - passed cleanly.
- `npm run build` - passed; post-build `git status --short` showed only the intended docs/`next-env.d.ts` changes.
