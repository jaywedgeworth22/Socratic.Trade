# 2026-07-12 - kalshi-data-fetcher

## Summary

- New `src/lib/kalshi.ts`: a self-contained, flag-gated Kalshi event-market data client —
  package K1 (lane K1) of the capability program's Kalshi integration design. DORMANT
  PLUMBING: nothing imports it yet; Wave 2 wires it into the strategist.
- Contents: env-derived config (`KALSHI_ENV` demo|prod selects the base URL; absent =>
  module inert), RSA-PSS/SHA-256 request signing (`signKalshiRequest` +
  `kalshiAuthHeaders`, headers `KALSHI-ACCESS-KEY`/`-TIMESTAMP`/`-SIGNATURE`, signed
  payload = timestamp_ms + METHOD + path-without-query including the `/trade-api/v2`
  prefix), typed public market-data fetchers (`fetchKalshiMarkets`, `fetchKalshiEvent`,
  `fetchKalshiSeries`), cents parsing (`centsToProbability`, `impliedProbability` =
  bid/ask mid with last-price fallback, never fabricated), and the normalized signal
  surface `getKalshiEventSignals(seriesList)` returning
  `{ seriesTicker, marketTicker, title, probability, probabilityBasis, volume24h,
  openInterest, closeTime, asOf }[]` for later strategist injection.
- 15-min success-only in-memory cache (failures never cached and never poison a prior
  success); per-series fail-soft (one failing series is skipped, total failure returns
  `[]`); 10s request timeout; only import is `node:crypto`.
- New `test/kalshi.test.ts`: 31 unit tests, mocked fetch, no network. Signing correctness
  is verified against a keypair generated with node crypto (RSA-PSS is salted, so tests
  verify signatures and prove the exact covered message — including that the query string
  and lowercase method do NOT verify), plus cents parsing, env/base-URL selection, signed
  vs unsigned header behavior, inert-when-unconfigured (fetch never called), error paths
  (HTTP 4xx/5xx, network throw, malformed JSON), per-series fail-soft, liquidity capping,
  and cache semantics.

## Why

- Owner-directed capability program (Kalshi lane). Phase-1 design (kalshi-design lane of
  workflow w76an10kd) picked "data as regime evidence first, trading later": Kalshi's
  CFTC-regulated event markets carry real-money-implied macro probabilities (Fed/CPI/
  recession/shutdown) useful as LLM strategist evidence. This PR ships the K1 fetcher as
  new-files-only dormant plumbing so Wave 2 can wire it into strategy.ts /
  market-signals without touching keepout files now.
- Feasibility corrections from the design review are baked in: prices parsed as INTEGER
  CENTS 1-99 (the `*_dollars` string fields are a parallel form, ignored); subaccounts
  (1-63, institution-gated) ignored entirely; auth verified as RSA-PSS SHA-256 with the
  three KALSHI-ACCESS-* headers over timestamp+method+path-without-query; demo REST base
  is `https://external-api.demo.kalshi.co/trade-api/v2`, prod
  `https://external-api.kalshi.com/trade-api/v2`, derived from `KALSHI_ENV` so demo/prod
  credentials can never cross.
- Explicitly NOT in this change (Wave 2 keepouts): no strategy.ts / data-providers.ts /
  types.ts edits, no UI, no BrokerGateway, no order placement of any kind.

## Files

- `src/lib/kalshi.ts` (new)
- `test/kalshi.test.ts` (new)
- `docs/rollouts/2026-07-12-kalshi-data-fetcher.md` (this note)
- `docs/EFFORT-LOG.md` (row)
- `STATUS.md` (stanza)

## Verification

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit` — clean (Node 24.18.0).
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run test/kalshi.test.ts` — 31/31
  passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx eslint src/lib/kalshi.ts
  test/kalshi.test.ts` — 0 errors, 0 warnings.
- Full `npm test` / `npm run build` deferred to the serialized Land phase per the lane
  instructions (module is dormant — no existing file changed, so the new test file is the
  only behavior surface).

## Follow-ups

- Wave 2 (separate lanes, keepout files): inject `getKalshiEventSignals` output as an
  `eventMarkets` prompt block next to marketSignals in strategy.ts, with reading guidance
  in strategy-prompts.ts (weight by openInterest, treat as regime evidence, never
  single-name triggers); curated default series list (Fed/rates, CPI/inflation,
  recession/GDP, labor, shutdown/debt-ceiling; elections behind an owner toggle).
- K2 trading (design sketch only): Kalshi as a sixth BrokerGateway — v2 events-orders API
  only, instrument namespacing decision, settlement reconciliation, parabolic fee model.
  Owner decisions pending per the Phase-1 design.
- Spot-check the curated series tickers against live Kalshi series at Wave-2 time (series
  tickers churn; this module takes the list as an argument precisely so no ticker is
  hardcoded here).
