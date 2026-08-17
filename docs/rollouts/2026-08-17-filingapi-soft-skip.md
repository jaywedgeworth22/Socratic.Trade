# 2026-08-17 — FilingAPI optional key, degrade on missing/401

## Context & Objective

Owner reversed the #2787 retirement.  Keep the filingapi.dev integration.  Stop using the dead stored `FILINGAPI` key (prod 401).  When the key is missing, invalid, or 401, skip the lane without failing health and fall back to ROIC (and SEC EDGAR for 10-K/10-Q).  A later valid key is used again.  Do not buy FilingAPI Plus.  Do not charge Stripe.  Retarget #2778 from "buy a Plus key" to "optional key, degrade gracefully."

#2787 already merged to `main` as `b4666e74`.  This follow-up reverts that squash and implements the skip.

## Changes Made

- Restored `FilingApiEnrichmentProvider`, the `filingapi` health probe, capability-matrix entries, catalog, quotas, and Connections row.
- New `src/lib/filingapi-auth.ts`: SHA-256 fingerprint of the secret; in-memory rejected set.  After the first 401/403 that fingerprint is not called again.  A different key is tried.
- Cascade registers FilingAPI only when `shouldUseFilingApiKey` is true.
- `getJson` logs 401/403 as soft health and marks the fingerprint rejected.
- Health probe: no key → `ok` `no-key-skip`; known-dead → `ok` `unauthorized-skip` (no HTTP); live 401/403 → mark + `ok` skip.
- `logApiHealth` force-softs filingapi 401/403/unauthorized text so leftover hard rows do not page.
- Connections unlocks copy: optional; ROIC/EDGAR fallback; no Plus checkout.

Touched files:

- `src/lib/filingapi-auth.ts` (new)
- `src/lib/data-providers.ts`
- `src/lib/db-health.ts`
- `src/lib/health-lane-reprobe.ts`
- `app/api/keys/route.ts`
- `.env.example`
- `test/filingapi-auth.test.ts` (new)
- `test/health-alert-noise-gate.test.ts`
- `test/health-lane-reprobe.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-4-market-data-scoring.md`
- `docs/source-capability-matrix.md`
- `docs/market-data-provider-pricing.md`
- `docs/rollouts/2026-08-17-filingapi-soft-skip.md`

## Decisions & Trade-offs

- Did not delete Infisical `FILINGAPI` from this VM.  Code stops using a fingerprint after the first 401.  Owner can remove the dead value from Infisical / Connections when convenient.
- Did not hardcode the dead key's hash.  A later different key must be tried.
- Did not retire the host.  #2787's `retired-direct-vendors` block is undone.
- 5xx from filingapi.dev still fail the health probe (real outage).  Only auth-shaped failures are skips.
- Two spaces after sentence terminators in user-facing copy.

## Verification State

Commands run (this note will be updated with receipts):

```bash
npm run lint
./node_modules/.bin/tsc --noEmit
npx vitest run test/filingapi-auth.test.ts test/health-alert-noise-gate.test.ts test/health-lane-reprobe.test.ts test/filingapi-and-new-rapidapi.test.ts
npm test
npm run build
```

## Next Steps & Blockers

- Merge this follow-up so prod stops calling filingapi.dev with the dead 401 key and stops paging the lane.
- Owner may delete the dead Infisical `FILINGAPI` value; not required for the skip to work after the first 401.
- Do not start FilingAPI Plus checkout.  Do not charge Stripe.
- Reopen / retarget #2778 to this degrade path (effort-board row is the source of truth).

## Zero-Code Findings

None beyond the owner correction: retirement was the wrong goal; the integration stays, the dead key must not stay in use.
