# BGE-M3 SEC Filings Reindexing & API Support

## Summary
Modified the SEC reindexing admin endpoint and created a command-line tool to clear caches and trigger corpus-wide reindexing under the BAAI BGE-M3 embedding model (`baai/bge-m3`).

## Why
Switching from Voyage to BGE-M3 requires clearing existing RAG SQLite caches and re-ingesting/re-embedding SEC filings. Providing both an API endpoint extension and a dedicated CLI script allows the operator to execute this task securely, either programmatically (in batches) or directly from the terminal without HTTP route timeout limits.

## Files Touched
- [`app/api/admin/reindex-10k/route.ts`](file:///Users/jay/Code/Socratic.Trade/app/api/admin/reindex-10k/route.ts)
- [`scripts/reindex-all.ts`](file:///Users/jay/Code/Socratic.Trade/scripts/reindex-all.ts)
- [`test/reindex-all.test.ts`](file:///Users/jay/Code/Socratic.Trade/test/reindex-all.test.ts)
- [`test/securities-import.test.ts`](file:///Users/jay/Code/Socratic.Trade/test/securities-import.test.ts)
- [`test/token-budget-ceiling.test.ts`](file:///Users/jay/Code/Socratic.Trade/test/token-budget-ceiling.test.ts)
- [`package.json`](file:///Users/jay/Code/Socratic.Trade/package.json)
- [`package-lock.json`](file:///Users/jay/Code/Socratic.Trade/package-lock.json)

## Verification
1. **TypeScript Verification**:
   `npx tsc --noEmit` compiles without errors.
2. **Lint Verification**:
   `npm run lint` exits clean (0 errors, 582 warnings).
3. **Vitest Verification**:
   Ran the entire test suite. Focused on the new and modified tests:
   - `npm test -- test/reindex-all.test.ts --run` -> PASS (2/2)
   - `npm test -- test/securities-import.test.ts test/token-budget-ceiling.test.ts --run` -> PASS (25/25)
4. **Next.js Production Build**:
   `npm run build` completed successfully. Included `@opentelemetry/core`, `@opentelemetry/sdk-trace-base`, and `@opentelemetry/resources` as devDependencies to resolve pre-existing compiler module resolution issues.

## Follow-ups
None. Feature is fully complete and ready to land.
