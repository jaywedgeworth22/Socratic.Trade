# Market-Data Freshness: Real-Time vs Delayed — Decision & Architecture Note

Date: 2026-07-01
Status: Decision recorded. Implementation tracked in
`docs/market-data-freshness-implementation-plan.md`.

## Framing (read this first)

`agentic-trading` is a **general, multi-strategy, multi-broker US-equity engine**.
No single strategy (congressional/insider trades included) and no single broker
(Alpaca included) is primary — treat them as interchangeable plugins. Evaluate
data and infrastructure on **strategy- and broker-neutral merits**, never on the
assumption that the app is "the congress app" or "the Alpaca app." The
congress.trade side project is only a *possible timing edge* on people trading
public disclosures; the engine must perform just as well with zero political
data.

## The governing principle

**Real-time data is worth only what your slowest reaction cadence can act on.** A
live quote beats a 15-minute-delayed one *only* where the app's logic reacts to
price faster than 15 minutes on that symbol. So the question is per decision
layer, not global.

## The three decision layers (from the code)

| Layer | Cadence | Names | Real-time delta | Source today |
|---|---|---|---|---|
| **Bulk candidate scan** | ~hourly, 5-min cached | 500–8,000 | **Zero** — no vendor sells real-time on 8k names cheaply and the app doesn't act on it intraday | NASDAQ screener + Yahoo (delayed), Massive/FMP if keyed (`market.ts`) |
| **BUY decision + order submit** | ~hourly (`runCadenceMinutes`, default 60; `scheduler.ts:288`) | top ~30 → the 1–5 actually bought | **Low, but non-zero at the *order* moment** — the entry-drift gate and sizing/limit price want a current quote on the names about to trade | broker quotes re-fetched at approval (`strategy.ts:1502-1511`) |
| **SELL / trailing stops** | **every 60s tick** (`synthetic-stops.ts:170`, `scheduler.ts:254-259`) | 5–20 open positions | **This is the only layer where real-time genuinely matters** — a 15-min delay fires stops up to 15 min late → materially worse fills on fast/gap moves | broker quotes fetched fresh per tick |

The app is **already** structured as "delayed bulk + real-time hot-set on demand":
the bulk universe runs on cached/delayed data, while a small hot set (open
positions every tick; approval candidates per run) is re-quoted on demand via
`gateway.getEquityQuotes`. That is the correct architecture — it does not need to
be invented, only tightened.

## Vendor landscape (corrected, mid-2026)

Prices verified against live pricing pages 2026-07-01. Note the two corrections
that reversed earlier assumptions in this analysis:

| Vendor | Real-time US quotes? | Cost | Role |
|---|---|---|---|
| **Broker feeds** (Alpaca/Robinhood/etc.) | Yes, for the connected venue | **Free** | Real-time hot-set quotes + the tape you fill on |
| **FMP** (owner has ~$30 tier) | Yes (Starter+ includes real-time US) | ~$30/mo (owned) | Real-time REST quotes + fundamentals |
| **Massive / Polygon** (owner has $30) | **No** — Starter $29 & Developer $79 are **15-min delayed**; real-time starts at **Advanced $199** | $30/mo (owned) | Deep historical/tick archive for backtests (delay irrelevant there) |
| **Twelve Data** | Yes even on Grow $29 (real-time US listed on Basic/Grow) | Grow $29 / Pro $99 | Optional redundant real-time source. **Pro $99 is bad value here** — the $70 over Grow is EU/AU/fixed-income/mutual-fund data, useless for a US-equity engine. Production WebSocket streaming only exists at Pro (Grow has trial WS only). |

### Corrections worth remembering
- **Twelve Data prices each tier via a credits dropdown**, so a tier spans a price
  range (Grow $29→$79; Pro $99→$229). The "$99 plan" is real (base Pro); it was
  not repriced away.
- **Polygon/Massive Developer $79 is delayed, not real-time.** Real-time US is
  $199 (Advanced). Do not treat Developer as a real-time backbone.

## Decision

1. **Do not buy Twelve Data (or any new feed) for this.** The owner already has
   what the engine needs: **FMP ~$30 (real-time REST) + broker feeds (free
   real-time on traded names) + Massive $30 (deep history for backtests)**. Twelve
   Data would be a redundant third real-time source; its only *new* capability
   (production WebSocket streaming) lives in the bloated Pro $99 tier.
2. **The lever is not a vendor — it is configuration + a small source-router.**
   The app already implements marketable-limit conversion, entry-drift, and a
   staleness gate; they are default-OFF and un-tuned, and the hot-set quote source
   is not guaranteed real-time when no real-time broker is connected.
3. **Spend on real-time streaming only if/when exits move from poll to push.** A
   streaming plan (Twelve Data Pro, Alpaca Algo Trader Plus $99, or a broker
   stream) earns its cost only after the synthetic-stop monitor is re-architected
   from 60s polling to an event-driven subscription. Build the push path first,
   then decide.

## Frequency-of-benefit summary

- **Bulk scan:** never benefits from real-time.
- **Entry layer:** ~never notices real-time at the hourly *decision*; benefits
  only at the *order-submission* instant (spread control on the 1–5 traded names),
  and only if order types actually consume the live bid/ask.
- **Exit layer:** benefits **occasionally but with high impact** (a fast move
  inside a 15-min window that a stop would have caught) — and the app already
  polls real-time here, so the win is already largely captured at 60s.

Net: the marginal improvement is better bought with **configuration + a poll→push
exit refactor** than with a new data subscription.

## References
- Vendor pricing: <https://massive.com/pricing>, <https://twelvedata.com/pricing>,
  <https://site.financialmodelingprep.com/pricing-plans>, <https://alpaca.markets/data>
- Code: `src/lib/scheduler.ts`, `src/lib/synthetic-stops.ts`, `src/lib/strategy.ts`,
  `src/lib/policy.ts`, `src/lib/market.ts`, `src/lib/types.ts`
