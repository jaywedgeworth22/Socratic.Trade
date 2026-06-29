# Blocked proposal decision persistence

## Summary
When a proposal is blocked by policy at approval time (e.g. daily notional limit
exceeded), the block reasons were never persisted to the `decision` column. The
"Latest Decisions" card showed the stale original `decision` (which said
`approved: true, reasons: []`), so a blocked proposal appeared invisible in the
feed — no reasons, no fallback text.

## What changed
1. `src/lib/db-proposals.ts` — added optional `decision?: PolicyDecision`
   parameter to `updateProposalStatus`, wired into the UPDATE query via
   `COALESCE`. Backwards-compatible: all existing call sites pass `undefined`
   and behave identically.
2. `src/lib/strategy.ts` — both blocked paths (tradability reject + policy
   reject) now pass the full `PolicyDecision` to `updateProposalStatus` so the
   actual block reasons survive.
3. `app/dashboard-client.tsx` — added missing `"blocked"` fallback in
   `decisionLedgerReasons` ("Blocked by policy.") matching the pattern already
   present for `"rejected"`, `"expired"`, and `"withdrawn"`.

## Why
User reported approving a trade, seeing the "Daily notional limit would be
exceeded" toast, then finding the proposal gone from both "Pending Approval"
and "Latest Decisions". The proposal WAS in the DB with `status = "blocked"`,
but the card had zero reasons and no fallback label, making it effectively
invisible.

## Files touched
- `src/lib/db-proposals.ts` — added `decision` param to `updateProposalStatus`
- `src/lib/strategy.ts` — persist block reasons on both rejection paths;
  added `PolicyDecision` import
- `app/dashboard-client.tsx` — added `"blocked"` fallback in `decisionLedgerReasons`

## Verification
- `npx tsc --noEmit` — clean on changed files
- `npm test` — 159 files / 1538 tests pass
- `npx eslint src/lib/db-proposals.ts src/lib/strategy.ts app/dashboard-client.tsx` — 0 errors

## Follow-ups
- The "blocked" proposals row in the proposals list (under Reports tab) may
  also need the same decision-column fix for its reasons column — verify.
