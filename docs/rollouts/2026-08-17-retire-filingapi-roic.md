# Retire FilingAPI.dev — ROIC.ai covers the class

## Context & Objective

The owner has ROIC.ai access and not filingapi.dev.  The stored `FILINGAPI` key is a dead 401; issue #2778 asked for a Plus checkout.  That checkout is refused (do not charge the owner's Stripe, which is Congress.Trade billing).  Goal: no live HTTP to filingapi.dev, while ROIC + SEC EDGAR stay unchanged.

## Changes Made

FilingAPI.dev is now a retired direct vendor, same class as FMP / Quiver / Unusual Whales:

- Cascade no longer registers `FilingApiEnrichmentProvider` even when a leftover key resolves.
- Health lane `filingapi` no longer GET `https://filingapi.dev/v1/company/AAPL`.
- `fetchWithRetry` refuses `filingapi.dev` before opening a socket.
- Connections catalog marks the row retired; leftover env names still resolve so the row can show as muted OFF.
- Capability matrix / data catalog list it as retired (`stAllowed: false`).
- Rate-limit pacer and 45/day quota removed (no live caller).
- `.env.example` no longer documents `FILINGAPI=`.
- #2778 retargeted on the effort board: Plus checkout superseded; do not buy Plus.

ROIC.ai (`RoicAiEnrichmentProvider`, health lane `roic`) and SEC EDGAR (`src/lib/web-sources/sec-filings.ts`, SEC XBRL) were not edited.

Touched files:

- `src/lib/retired-direct-vendors.ts`
- `src/lib/data-providers.ts`
- `src/lib/health-lane-reprobe.ts`
- `src/lib/provider-rate-limit.ts`
- `src/lib/provider-tier-plan.ts`
- `src/lib/source-capability-matrix.ts`
- `src/lib/data-catalog.ts`
- `src/lib/db-api-keys.ts`
- `src/lib/nasdaq-calendar-provider.ts` (comment only)
- `app/api/keys/route.ts`
- `app/console/settings/api-keys.tsx`
- `.env.example`
- `test/retired-direct-vendors.test.ts`
- `test/data-providers.test.ts`
- `test/health-alert-noise-gate.test.ts`
- `test/provider-rate-limit.test.ts`
- `test/provider-tier-plan.test.ts`
- `test/source-capability-matrix.test.ts`
- `test/filingapi-and-new-rapidapi.test.ts`
- `docs/source-capability-matrix.md`
- `docs/phase-4-market-data-scoring.md`
- `docs/market-data-provider-pricing.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-17-retire-filingapi-roic.md`

## Decisions & Trade-offs

- Followed the FMP retirement pattern (hard-block host + intentional-off health + catalog archaeology) instead of deleting leftover `FILINGAPI` env aliases.  A leftover Infisical value must not look like a missing key to restore.
- Deleted the provider class and parsers rather than leaving a dead HTTP client.  Nothing called them after un-registration.
- Did not touch ROIC harvest, ROIC health, or EDGAR 10-K/10-Q ingest.
- Did not charge Stripe or open filingapi.dev Plus checkout.

## Verification State

Commands run (this rollout):

```bash
npx tsc --noEmit
npx vitest run test/retired-direct-vendors.test.ts test/data-providers.test.ts test/health-alert-noise-gate.test.ts test/provider-rate-limit.test.ts test/provider-tier-plan.test.ts test/source-capability-matrix.test.ts test/filingapi-and-new-rapidapi.test.ts
npm run lint
npm test
npm run build
```

Status filled in after the gate.

## Next Steps & Blockers

- After merge: leftover Infisical `FILINGAPI` can stay; it is unused.  Do not replace it with a Plus key.
- Close #2778 via effort-board sync (Plus checkout row moved to Completed / superseded).
- No owner Stripe action.

## Zero-Code Findings

Re-verified on this branch before editing: `FilingApiEnrichmentProvider` still hit `/v1/company`, `/v1/calendar/earnings`, `/v1/insiders`; health lane still GET `https://filingapi.dev/v1/company/AAPL`; strategy / Green/Red / RAG do not hard-depend on that lane.  Critical health services remain pinecone / alpaca-broker / rag.
