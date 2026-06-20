# 2026-06-20 - project-rename-alignment

## Summary

- Aligned the overall dashboard and repository documentation titles to "Agentic Trading" or "Agentic Trading Dashboard".
- Updated `PLAN.md` to reference the project as "Agentic Trading Dashboard" rather than "Robinhood Agentic Dashboard".

## Why

- As the application now supports multiple brokers (Alpaca and Robinhood) and broker-neutral setups, it should be called "Agentic Trading Dashboard" rather than "Robinhood Agentic Trading".

## Files

- `PLAN.md`
- `STATUS.md`

## Verification

- Run `npx tsc --noEmit`
- Run `npm test` (all 287 tests succeeded)
- Run `npm run build` (Next.js production compilation completed successfully)

## Follow-ups

- None
