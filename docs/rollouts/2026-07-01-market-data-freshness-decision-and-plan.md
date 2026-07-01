# 2026-07-01 — Market-data freshness: real-time vs delayed decision + implementation plan (Claude)

Branch: `claude/stock-data-pricing-comparison-2wzg8u`

## Summary
Docs-only change. Added two design docs capturing a real-time-vs-15-min-delayed
market-data analysis for the trading engine and the concrete work to act on it:
- `docs/market-data-freshness-decision.md` — decision + architecture note.
- `docs/market-data-freshness-implementation-plan.md` — sequenced implementation
  plan (4 workstreams).

No code paths were touched.

## Why
Owner is evaluating a ~$100/mo stock-data budget and whether to add a Twelve Data
plan on top of the FMP (~$30) and Massive/Polygon ($30) subscriptions already
held. The real question is where quote freshness actually changes decisions in
*this* app, given its cadence (buys ~hourly, exits every 60s), and what would have
to change to exploit real-time.

## Key findings (grounded in the code)
- The engine is already "delayed bulk + real-time hot-set on demand": bulk scan
  runs on cached/delayed data; open positions (`synthetic-stops.ts:170`, per 60s
  tick) and approval candidates (`strategy.ts:1502-1511`) are re-quoted on demand
  via `gateway.getEquityQuotes`.
- Real-time matters **only** at the 60s exit layer and at the order-submission
  instant for the 1–5 traded names — both small hot sets already quotable in real
  time for free via the connected broker (and FMP as a paid real-time REST source).
- The primitives to exploit this already exist but are **default-OFF / un-tuned**:
  `maxEntryDriftPct` (`policy.ts:109-127`), `maxQuoteAgeSec`/`maxFundamentalsAgeSec`
  (`policy.ts:132-168`), `marketableLimitEntries` + `tuning.marketableLimitBufferBps`
  (`strategy.ts:1191-1192, 2764-2773`).
- Vendor corrections: Twelve Data tiers are priced by a credits dropdown (Pro base
  is a real $99, not repriced away), but Pro's increment over Grow $29 is
  EU/AU/fixed-income/mutual-fund data — useless for a US-equity engine.
  Massive/Polygon Developer $79 is **15-min delayed**; real-time is $199 (Advanced).
- Decision: **do not add a new data feed.** FMP + broker (free real-time on traded
  names) + Massive (deep history) already cover the need. The lever is config +
  a small hot-set quote-source router + an optional poll→push exit refactor.

## Files
- Added: `docs/market-data-freshness-decision.md`
- Added: `docs/market-data-freshness-implementation-plan.md`
- Added: `docs/rollouts/2026-07-01-market-data-freshness-decision-and-plan.md` (this note)
- Updated: `STATUS.md` (new dated snapshot entry), `PLAN.md` (new deferred workstream)

## Verification
Docs-only; no code paths changed, so the tsc/test/build trio was intentionally not
run (it would be unaffected). If/when the implementation-plan workstreams are
built, the full `npm run lint` → `npx tsc --noEmit` → `npm test` → `npm run build`
trio applies before claiming complete.

## Revision (same PR, 2026-07-01) — Codex review fixes + Twelve Data free tier
Addressed two Codex P2 review comments on PR #288 and folded in the owner's
Twelve-Data-free insight (all doc-only):
- **Broker real-time is entitlement-dependent** (decision doc): corrected the
  overstated "broker feeds = free real-time." Alpaca *free* REST (`getLatestQuotes`,
  the path `getEquityQuotes` uses) is 15-min delayed; real-time needs WebSocket or a
  paid feed. Qualified the vendor table, Decision #1, and the exit-layer
  frequency bullet.
- **Router must cover the autonomous run site** (plan doc): added `strategy.ts:217`
  (run-cycle quote merge) to Workstream 2's router scope alongside the approval and
  synthetic-stop sites, with a matching verify case. Without it, autonomous
  Test/delayed-broker entries would keep consuming stale quotes.
- **Twelve Data free Basic as a $0 real-time fallback**: added as an explicit tier in
  the router precedence (`broker real-time → FMP → Twelve Data free → stamped-stale
  DB`), gated to on-demand small-N pre-trade lookups (8 credits/min, 800/day; never
  bulk), with two verify-once notes (genuine US real-time on Basic; per-credit quote
  cost). This is most valuable precisely when the broker entitlement is delayed.

## Follow-ups
- Workstream 1 (enable/tune `maxQuoteAgeSec`, `maxEntryDriftPct`,
  `marketableLimitEntries` + surface in settings UI) — recommended first.
- Workstream 2 (hot-set quote-source router with honest `asOf` + FMP fallback) —
  the one genuine code gap.
- Workstream 3 (poll→push trailing-stop stream) — only if pursuing a streaming
  data plan; build the push path before buying streaming.
- Workstream 4 (intraday entry triggers) — deferred, strategy-level.
