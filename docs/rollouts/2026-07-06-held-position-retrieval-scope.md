# 2026-07-06 - held-position-retrieval-scope

## Summary

- Widened the three retrieval scopes inside `runStrategyOnce` (`src/lib/strategy.ts`) — filings
  RAG, learned-context, and episodic decision memory — so a held (open) position that scores
  outside the score-sorted top-N scan slice still gets a retrieval pass. Previously these three
  scopes were built ONLY from `marketScan.topCandidates.slice(0, N)` (N=3 for filings-RAG and
  episodic, N=8 for learned-context), which is score-sorted BUY-candidate ranking — a held symbol
  ranked below the cutoff got zero retrieved memory, so sell/hold/trim decisions on it ran with no
  filings context, no learned facts, and no historical analogs/coaching.
- Strictly additive: held symbols are UNIONed (Set-dedupe) into each scope's local symbol list.
  The BUY-candidate scan/prompt set (`marketScan.topCandidates` itself, its membership, and its
  score-sorted order) is completely untouched — nothing was shrunk, reordered, or removed from it.
  No risk-gate, sizing, or policy code was touched.
- Hoisted the `heldSymbols` computation (`new Set(workingPositions.map(p =>
  normalizeSymbol(p.symbol)))`) to a single point right after `workingPositions` is assigned, and
  reused it both for the pre-existing take-profit trim-band pruning (previously recomputed
  locally at that call site) and for all three retrieval scopes below.

## Why

- Ground truth from triage: `workingPositions` (open broker positions) already flow into
  proposal generation and trim/exit logic, but the RAG/learned-context/episodic retrieval passes
  only ever looked at `marketScan.topCandidates` — the score-sorted BUY-candidate scan set. A
  position the agent is holding but which no longer scores well (a classic "should I sell this"
  situation) got NO retrieved memory of past decisions, filings, or learned facts on it, even
  though that is exactly the decision retrieval should be informing.
- `marketScan.topCandidates` already force-includes every held symbol via `market.ts`'s
  `heldExtra` union (so the full candidate shape — sector/dominantFactor/evidence — is always
  available for a lookup), it just isn't guaranteed to land in the TOP slice used by these three
  retrieval call sites.
- Owner philosophy (binding): guardrails/receipts are advisory and retrieval widening must never
  narrow or reorder the existing BUY-candidate scan/prompt set — this change is purely additive.

## Files

- `src/lib/strategy.ts` — hoisted `heldSymbols`; unioned it into the filings-RAG `topSymbols`,
  the learned-context `learnedSymbols`, and the episodic `situationCandidates` (via a new
  `toSituationCandidate` helper extracted from the existing top-3 mapping, plus a
  `marketScan.topCandidates` lookup with a minimal symbol+sector fallback for the defensive case).
- `test/strategy-held-position-retrieval-scope.test.ts` (new) — 2 tests:
  1. Held symbol scoring below the top-3/top-8 cutoff still gets a filings-RAG call, is unioned
     into the learned-context symbol list, and appears in the episodic `candidates` array —
     additively, alongside the (unchanged) top-N BUY candidates.
  2. Held symbol scoring INSIDE the top slice does not trigger a duplicate retrieval call for
     itself in any of the three scopes (regression / dedupe check).
- `STATUS.md`, `docs/EFFORT-LOG.md` — dated status entry + In Progress board row (this rollout).

## Verification

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run test/strategy-held-position-retrieval-scope.test.ts` — 2/2 passed.
- `npx vitest run test/strategy-episodic-injection.test.ts test/take-profit-trim-db.test.ts test/strategy-prompt-safety.test.ts test/strategy-rationale-collapse-gate.test.ts test/strategy-bear-fail-closed.test.ts` — 16/16 passed (regression check on the touched code paths).
- `npx vitest run test/run-strategy-offline.test.ts test/strategy-bull-truncation.test.ts test/strategy-copy-to-account.test.ts test/strategy-hardening.test.ts test/strategy-llm-failover.test.ts test/strategy-money-path-f-g.test.ts test/strategy-moneypath-drawdown-flip.test.ts test/strategy-prompt-version.test.ts test/strategy-rag-quickwins-wiring.test.ts test/strategy-review-display.test.ts test/strategy-tuning-missed-opps.test.ts test/strategy-tuning.test.ts test/usage-budget-strategy-integration.test.ts` — 98/98 passed.
- `npx vitest run test/experience-memory.test.ts test/learned-context-pending.test.ts test/learned-context-queue-ui.test.ts test/learned-context-sharing.test.ts test/learned-context.test.ts test/market-custom-symbol.test.ts test/market-dynamic-universe.test.ts test/market-hours.test.ts test/market-internals.test.ts test/market-regime.test.ts test/market-signals.test.ts test/market.test.ts` — 139/139 passed.
- Did NOT run the full `npm test` or `npm run build` per the scoped-agent instructions — a
  central operator lands sequentially and runs the full gate.
- Test-writing note: the new test's second case initially flaked because the nasdaq-screener
  response is cached in-module (`screenerCache` in `src/lib/market.ts`) by TTL — the two `it`
  blocks in the same file were silently sharing test 1's cached rows/scores. Fixed by calling the
  existing `clearMarketCache()` export at the top of each test (same pattern used in
  `test/market-custom-symbol.test.ts`).

## Follow-ups

- None identified. The change is intentionally minimal/localized to the three named retrieval
  call sites in `strategy.ts`; no other retrieval scope in the codebase was in scope for this
  slug.
