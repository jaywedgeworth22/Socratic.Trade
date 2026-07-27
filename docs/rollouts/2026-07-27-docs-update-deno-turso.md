1. **Context & Objective**: A user pointed out that `congress.trade` does not use Cloudflare Workers, but rather Deno Deploy and Turso. This updates the outdated comments in `congress-share.ts`.
2. **Changes Made**:
   - `src/lib/congress-share.ts`: Updated the line `App A (congress.trade, a Cloudflare Worker backed by a DB)` to `App A (congress.trade, hosted on Deno Deploy and backed by Turso)`.
3. **Decisions & Trade-offs**: N/A
4. **Verification State**: `npm run lint` and `npx tsc --noEmit` pass in `land.sh`.
5. **Next Steps & Blockers**: N/A
6. **Zero-Code Findings**: N/A
