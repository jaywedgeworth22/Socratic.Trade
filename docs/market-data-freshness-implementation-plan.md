# Market-Data Freshness — Implementation Plan

Date: 2026-07-01
Companion to `docs/market-data-freshness-decision.md`.
Scope: make real-time quotes *matter where they should* and *not cost where they
shouldn't*, without buying a new data feed.

## Key finding: most primitives already exist (default-OFF / un-tuned)

Audit of `src/lib/policy.ts`, `strategy.ts`, `synthetic-stops.ts`, `types.ts`:

| Capability | Field / call site | State |
|---|---|---|
| Entry-drift guard | `policy.maxEntryDriftPct` — enforced `policy.ts:109-127` | Implemented; **default unset (OFF)** |
| Staleness gate | `policy.maxQuoteAgeSec` / `maxFundamentalsAgeSec` — enforced `policy.ts:132-168` | Implemented; **default OFF** |
| Marketable-limit entries | `policy.marketableLimitEntries` + `tuning.marketableLimitBufferBps` — applied `strategy.ts:1191-1192`, `2764-2773` | Implemented; **default OFF** |
| Approval-time re-quote | `strategy.ts:1502-1511` re-scans + `getEquityQuotes` for hot set at approval | Implemented |
| Synthetic trailing-stop poll | `synthetic-stops.ts:170`, every 60s tick | Implemented (poll-based) |
| Broker-held OCO brackets / RH stops | `policy.brokerBracketsEnabled` (default ON, Alpaca), `robinhoodBrokerStops` | Implemented |
| Quote type carries freshness | `MarketQuote.bid/ask/asOf` (`types.ts:360-364, 644-661`) | Present |

So the work is **enable + route + (optional) push**, not "build."

---

## Workstream 1 — Enable & tune the existing gates (low effort, do first)

**Goal:** turn on the protections that are already coded but dormant.

1. **Staleness gate on the hot set.** Set a sane default `maxQuoteAgeSec`
   (recommend **120–300s**) for opening orders. It reads
   `MarketScan.quotesBySymbol[sym].asOf` (fallback candidate `asOf`), so it only
   works if the hot-set quotes carry an honest `asOf` — see Workstream 2.
   - Files: default/settings surface for `policy.maxQuoteAgeSec`; verify
     `policy.ts:132-168` behavior with a populated `asOf`.
2. **Entry-drift guard.** Set a default `maxEntryDriftPct` (recommend **1–2%** for
   liquid names) so an hours-old market/dollar entry can't fill far from its
   `referencePrice` (`policy.ts:109-127`).
3. **Marketable-limit entries.** Default `marketableLimitEntries = true` with
   `tuning.marketableLimitBufferBps` ~15 (`strategy.ts:1191`). Converts naked
   opening market orders into marketable limits priced through the quote — turns a
   fresh quote into real slippage control on the 1–5 traded names. Exits stay
   market by design (fill certainty; brackets are the exit-reliability mechanism).
4. **Surface all three in the policy/settings UI** with the recommended defaults
   and one-line help, so they are discoverable per-account.

**Risk:** these are fail-safe/additive; the main risk is a too-aggressive
`maxQuoteAgeSec` blocking entries in Test mode or when a broker feed is slow —
mitigate by tuning and by Workstream 2's honest `asOf` + fallback.

**Verify:** unit tests around `policy.ts` gates with fresh vs stale `asOf`;
confirm marketable-limit conversion fires only for opening orders and only when
`limit` is a permitted order type.

---

## Workstream 2 — Hot-set quote-source router with a freshness SLA (the one real gap)

**Problem:** `gateway.getEquityQuotes` routes to the connected broker. That is
real-time only on a **real-time entitlement/API path** — e.g. Alpaca *free* REST
(`getLatestQuotes`, which this call uses) is 15-min delayed; real-time there needs
WebSocket or a paid feed. So (a) in Test mode, with a delayed-only broker, or on a
delayed broker entitlement the hot-set quote may be delayed, and (b) there is no
explicit fallback to a real-time source when the broker feed is missing/stale, and
(c) `asOf` must be stamped honestly for the staleness gate to mean anything.

**Goal:** guarantee that the **hot set only** (open positions + approval
candidates + the proposal symbol) is served by a real-time source, with an honest
freshness stamp, without touching the bulk-scan path.

Design:
1. **Add a thin quote-source router** in front of **every hot-set fetch**. Wrap the
   `getEquityQuotes` call sites:
   - `strategy.ts:217` — **autonomous run-cycle** quote merge before LLM/deterministic
     sizing (the primary buy path; easy to miss — without it, autonomous entries in
     Test/delayed-broker mode keep consuming stale quotes while `maxQuoteAgeSec` and
     marketable limits assume router-stamped freshness).
   - `strategy.ts:1502-1511` / `1510` — **manual approval** re-quote.
   - `synthetic-stops.ts:170` — **60s exit** monitor.

   Order of precedence:
   `connected real-time broker (only if the entitlement/path is real-time) → FMP
   real-time REST → Twelve Data free Basic (on-demand, small-N) → last-known DB price
   (stamped stale)`. Bulk scan (`market.ts`) is explicitly **out of scope** and stays
   on delayed/cached data.
2. **Stamp `asOf` truthfully** at every tier so `maxQuoteAgeSec` can do its job;
   the DB-fallback tier must stamp the original quote time, never `now`. Broker quotes
   on a delayed entitlement must be stamped delayed (do not label delayed-REST as
   real-time), so the router can fall through to FMP/Twelve Data.
3. **Keep it small:** the hot set is single-digits to low-tens of names, so an
   on-demand real-time pull (broker/FMP/Twelve Data free) is cheap and rate-limit-safe.
   Do **not** route the 8k universe here. Twelve Data free is 8 credits/min (800/day) —
   strictly hot-set/pre-trade lookups only; a single bulk call would exhaust it.
4. **Twelve Data free — two things to verify once** before relying on it: that Basic's
   US-equity quotes are genuine real-time (not 15-min or trial-symbols-only), and the
   per-credit cost of the `/quote`|`/price` endpoint. It extends the existing keyed
   Twelve Data adapter (`data-providers.ts`), so this is adding a quote endpoint, not a
   new integration.
5. **Config:** a per-account "real-time hot-set source" preference
   (auto → broker → FMP → Twelve Data free), defaulting to auto.

**Why this is the gap:** it is what makes "delayed bulk + 5–10 real-time on
demand" a guarantee rather than an accident of which broker happens to be wired.

**Verify:** tests that (a) a delayed broker + keyed FMP yields a real-time-sourced
hot-set quote with recent `asOf`; (b) the router covers **all three** call sites —
`strategy.ts:217` (autonomous run), the approval re-quote, and the synthetic-stop
monitor — so an autonomous Test/delayed-broker entry gets router-stamped freshness;
(c) no path routes the bulk universe through the router; (d) a delayed-broker
entitlement falls through to FMP/Twelve Data rather than being trusted; (e)
DB-fallback quotes carry their true (older) `asOf` and are caught by the staleness
gate.

---

## Workstream 3 — Poll → push exit stream (higher effort; only if pursuing streaming)

**Goal:** fire trailing stops on the tick that *breaches*, not up to 60s later.
This is the only change that lets a *streaming* real-time plan beat what the app
already does at 60s polling.

1. Convert `runSyntheticStopMonitor` (`synthetic-stops.ts`) from a 60s poll to a
   **WebSocket subscription on open-position symbols** (subscribe on open,
   unsubscribe on close). Prior art: `docs/rollouts/2026-06-19-push-vs-poll-vwap-sentiment-sse.md`.
2. Keep the 60s poll as a **fallback/heartbeat** when the stream is down (the
   monitor already falls back to DB `lastPrice`; preserve that safety net).
3. **Only now** does a streaming feed have ROI. Options, cheapest first: broker
   streaming (free, if the connected broker offers it) → Alpaca Algo Trader Plus
   $99 (full SIP stream) → Twelve Data Pro $99 (WS). Decide at this step, not
   before — Grow $29 does **not** include production WS.

**Risk:** streaming adds connection-lifecycle and reconnect complexity; the poll
fallback must remain authoritative so a dropped socket never leaves a position
unmonitored.

---

## Workstream 4 — Optional: intraday entry triggers (strategy change, largest ask)

Only if the engine should *enter* intraday rather than on the hourly snapshot.
Adds intra-hour triggers (e.g. pullback-to-VWAP, breakout) on a small streamed
watchlist. This is a **strategy** change, not a data change, and it is the only
thing that makes faster *entry* data valuable. Out of scope for the near term;
listed for completeness.

---

## Recommended sequencing

1. **Workstream 1** (enable/tune gates) — days, no new infra, immediate slippage
   and stale-fill protection.
2. **Workstream 2** (hot-set source router) — the one genuine gap; makes the gates
   trustworthy and the "real-time on demand" story a guarantee.
3. **Workstream 3** (push exits) — only if pursuing streaming; build the push path
   *before* buying any streaming plan.
4. **Workstream 4** — deferred; strategy-level.

No new data vendor is required for 1–2. A streaming plan is a step-3 decision, not
a prerequisite.

## Handoff / verification checklist (per repo protocol)
- Run `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` before
  claiming any code change here complete (this doc changes no code paths).
- Update `STATUS.md` and a `docs/rollouts/` note per commit.
- Cross-file traps to respect when implementing: `TradeProposal` requires
  `tradeThesisTag`/`entryMarketRegime` (test fixtures too); persistence edits go in
  the owning `db-*` module.
