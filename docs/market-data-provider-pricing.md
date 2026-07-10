# Market-data provider pricing & tier facts (canonical)

Single source of truth for what each market-data provider costs, what each tier
actually unlocks, and the traps we have already misread once. **Update this file
whenever a plan changes or a price is re-verified — cite the source and date.**
The live subscription state (what we actually pay) belongs in the API-Usage-Monitor
app; this doc records the *vendor facts* so agents stop re-deriving (and
re-misinterpreting) them.

Verified 2026-07-10 against live vendor pages (headless-rendered where noted),
plus owner corrections. Trading-app integration facts verified against this repo
and prod `api_health_log` evidence the same day.

## Quick comparison — cheapest useful tier

| Provider | Free tier reality | Cheapest paid | Annual option | What paid unlocks (for us) |
|---|---|---|---|---|
| **Tiingo** | 50 req/hr, 1,000/day, 500 unique symbols/mo; **News API not included** (every news call 403s) | **Power $30/mo** | **$300/yr (2 months free)** — owner-verified 2026-07-10; the $499/yr on their site is the separate *commercial* license | 10,000 req/hr, 100,000 req/day, News API. **Fundamentals are NOT included** — separate contact-sales add-on on every tier |
| **Massive** (ex-Polygon, rebranded 2025-10-30) | 5 calls/min, EOD only, 2 yr history | **Stocks Starter $29/mo** — **we already pay this** | $288/yr ($24/mo effective) | Unlimited API calls, 15-min delayed, 5 yr history, WS aggregates. Real-time + trades/quotes + financial ratios = Advanced $199/mo |
| **FMP** | 250 calls/day, EOD | **Starter ~$22/mo billed annually** ($264/yr) — **our key behaves paid** | Annual-first pricing (monthly ≈ $29–34, not displayed) | 300 calls/min, real-time US quotes, **annual-only** fundamentals/ratios. Quarterly fundamentals need **Premium $59/mo-annual** ($708/yr), 750 calls/min |
| **Twelve Data** | 8 credits/min, 800/day | Grow $79/mo | $792/yr ($66/mo) | 377 credits/min, no daily cap. Credits = endpoint weight × symbols (fundamentals cost 100 credits/symbol — poor value for us). Real WebSocket starts at Pro $229/mo |
| **Finnhub** | 60 calls/min (generous), US-only | **All-In-One $3,500/mo** — annual-only ($42,000/yr) | n/a | No affordable paid step exists. Stay free |
| **Alpha Vantage** | Nominally 25 req/day — **but enforced PER IP**, so key rotation from one box is useless (proven in prod 2026-07-10: exactly 25 OKs, then all 6 pool keys instantly rejected) | $49.99/mo (75 req/min) | $499/yr ($41.58/mo, "2 months off") | Higher rate limits, no daily cap. Total overlap with FMP+Finnhub for us. Skip |
| **Yahoo Finance** | Keyless, free, no SLA — unofficial endpoints, can throttle/block anytime | n/a | n/a | Floor of the cascade, never a contract |

Sources: tiingo.com/pricing (+ owner-verified annual), massive.com/pricing (Stripe
plan payload embedded in page), site.financialmodelingprep.com/pricing-plans
(rendered; monthly toggle would not switch), twelvedata.com/pricing (+ support
articles 5194820, 5203360), finnhub.io/pricing (rendered), alphavantage.co/premium
(+ /support for the 25/day statement — per-IP enforcement is NOT documented there;
it is our own prod-observed fact).

## Traps already hit once (do not re-learn these)

1. **Tiingo News API is paid-only.** On the free key every `/tiingo/news` call
   returns HTTP 403 — that burned a third of our 50/hr budget and made tiingo look
   "down" in health until `TIINGO_DROP_NEWS=true` shipped (2026-07-10). If Power is
   purchased, flip that flag off; note tiingo has historically also required a
   use-case application for news access — confirm it's active before relying on it.
2. **Tiingo Power annual exists ($300/yr)** even though the public pricing matrix
   renders monthly-only — an agent misreported "no annual option" on 2026-07-10;
   owner corrected from the actual billing flow. Verify pricing in the signup/billing
   flow, not just the marketing matrix.
3. **Alpha Vantage caps per IP, not per key.** A 6-key rotation pool from one box
   yields 25 requests/day total. Their site never documents the per-IP behavior.
4. **FMP's displayed prices are annual-billed.** The "$22/mo" Starter is $264
   charged yearly; their monthly-billed price is hidden behind a toggle that may
   not render. Starter fundamentals are **annual statements only** — TTM/quarterly
   depth needs Premium.
5. **Massive ≠ quotes provider for us.** It's history + full-universe breadth +
   FINRA short interest. Real-time per-symbol quotes on Massive start at $199/mo —
   that job belongs to tiingo/brokers here.
6. **Finnhub has no middle tier.** Free (60/min) then $3,500/mo. Never budget for
   "Finnhub paid".

## What we run today (2026-07-10)

- **Paying:** Massive Stocks Starter ($29/mo — annual would save $60/yr), FMP
  (Starter-equivalent, key responds paid; the app's tier probe alerts if it lapses).
- **Free:** tiingo (news dropped), Twelve Data (window-gated to 8 credits/min),
  Finnhub, Yahoo, Alpha Vantage (effectively dead — per-IP cap).
- **Under consideration:** tiingo Power ($30/mo or $300/yr) — fixes the enrichment
  quote bottleneck + news; FMP Premium ($59/mo-annual) — only if quarterly-fresh
  ratios prove necessary after tiingo relieves cascade pressure.

## Where the dials live

Every quota/pacing/tier flag is an env var in **Infisical prod** (seeded with
code defaults 2026-07-10; boot-time injection ⇒ changes apply on the next deploy):
`PROVIDER_QUOTA_{TIINGO,TWELVEDATA}_PER_{MIN,HOUR,DAY}`,
`PROVIDER_RATE_LIMIT_{FINNHUB,ALPHA_VANTAGE,YAHOO_FINANCE,TWELVEDATA}_*`,
`TIINGO_DROP_NEWS`, `FINNHUB_DROP_RECOMMENDATION`, `ALPACA_DATA_FEED`,
`MASSIVE_{HISTORY,SHORT_INTEREST}_ENABLED`, `MASSIVE_REST_MAX_CALLS_PER_MINUTE`.
Resolution logic: `src/lib/provider-rate-limit.ts`. Subscription→knob automation
(API-Usage-Monitor as source of truth): the **Mac-side sync shipped 2026-07-10** —
`scripts/sync-provider-knobs.sh` + `scripts/com.jay.provider-knob-sync.plist` GET the
monitor's `/api/subscriptions`, map each plan's status to knobs (active→`knobEnv`,
canceled/paused→`freeTierKnobEnv`, considering→skip), and write only the diffs into
Infisical prod via the proven universal-auth CLI path (allow-listed keys only). It is
**gated on the monitor's `/api/subscriptions` endpoint** (parallel PR) and dry-runs by
default; the launchd job is not installed yet. See
`docs/rollouts/2026-07-10-provider-knob-sync.md`.

### Upgrade cheat-sheet

| You bought | Set in Infisical |
|---|---|
| tiingo Power | `PROVIDER_QUOTA_TIINGO_PER_HOUR=10000`, `PROVIDER_QUOTA_TIINGO_PER_DAY=100000`, `TIINGO_DROP_NEWS=false` |
| FMP Premium | (no quota knob today — FMP is throttled by `FMP_MAX_SYMBOLS` scan-derived cap; revisit if 429s appear) |
| Twelve Data Grow | `PROVIDER_QUOTA_TWELVEDATA_PER_MIN=377`, remove/raise `_PER_DAY` |
| Massive → free downgrade (don't) | `MASSIVE_REST_MAX_CALLS_PER_MINUTE=5` |
| Alpaca SIP feed | `ALPACA_DATA_FEED=sip` |
