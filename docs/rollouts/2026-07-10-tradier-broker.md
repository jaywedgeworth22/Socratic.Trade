# 2026-07-10 — Tradier broker adapter (fifth broker)

## Summary
Added Tradier as a fifth `BrokerGateway`, mirroring the Alpaca adapter but against
Tradier's hand-rolled REST API (single Bearer token, no SDK). A Tradier account is now
connectable (sandbox = paper, production = live), selectable as `policy.activeBroker`, and
routes real orders through the same `withLivePreflight` live-order choke point as every
other broker.

## Why
Owner wants both a production and a sandbox Tradier key independently connectable, with
the sandbox key treated as paper. Implemented per the provided SPEC + CONTRACT + WIRING
maps.

## Key design decisions
- **Environment is explicit, base URL is derived.** Tradier tokens carry no PK/PA-style
  prefix and each token is environment-scoped, so the connect UI has an explicit
  Sandbox/Production selector. `body.environment` → `ConnectedAccount.environment`
  (`paper`/`live`) → base URL (`https://sandbox.tradier.com/v1` vs
  `https://api.tradier.com/v1`), derived at BOTH persist time (route) and gateway
  construction. A mismatched token 401s at the wrong host and throws before any order —
  fails closed, can never trade on the wrong venue.
- **Whole-share only.** `getEquityTradability` reports `fractional:false`, and
  `placeEquityOrder` independently floors a `dollarAmount` order into whole shares at an
  anchor price and THROWS when `wholeQty < 1` or no positive price exists — never defaults
  to 1 (a $500 order must never become 500 shares).
- **Direct 4-value side map.** Tradier natively accepts `buy/sell/sell_short/buy_to_cover`,
  so `OrderSide` maps directly (short→sell_short, cover→buy_to_cover) with a symmetric
  read-back, instead of collapsing through `toBrokerSide`. Preserves explicit short/cover
  intent.
- **Synthetic stops, no OTOCO in v1.** `strategy.ts` gates broker brackets to Alpaca only,
  so `bracketTakeProfit`/`bracketStopLoss` are ignored; protection comes from the
  synthetic-stop monitor. Native Tradier OTOCO is a follow-up.
- **No operator env fallback.** A Tradier token is a single owned Bearer credential.
  Credentials resolve ONLY from a connected-account row whose `broker==="tradier"` for the
  caller's `userId`; a non-owner with no stored token throws loudly rather than trading on
  someone else's token.
- **Order-state normalization.** Tradier place returns `status:"ok"` (request-accepted, not
  an order state) → normalized to `"pending"` so `isLiveOrderState` recognizes it as
  resting, while a real terminal status (e.g. `"rejected"`) passes through verbatim so
  `isRejectedOrCanceledState` still catches a synchronous decline. Added `"error"` to
  `TERMINAL_DECLINE_STATES` and `"pending"` to `LIVE_ORDER_STATES` +
  `ACTIVE_BROKER_ORDER_STATES` (keeps the superset invariant guarded by
  `broker-side.test.ts`).

## Money-path safety
- The `withLivePreflight` Proxy in `broker.ts` is gateway-agnostic and gates only
  `placeEquityOrder`, so Tradier live placements inherit `assertLivePreflight`
  (ALLOW_LIVE_TRADING + genuinely-live derived state) for free. No Tradier-specific
  preflight added; `cancelEquityOrder` is deliberately left unguarded (risk-reducing).
- `placeEquityOrder` throws when Tradier returns no `order.id` (ExecutedOrder must carry a
  usable orderId for reconciliation; `String(undefined)` never becomes the literal
  "undefined").

## Files
- `src/lib/types.ts` — `"tradier"` added to `ConnectedAccount.broker` (line ~615) and
  `TradingPolicy.activeBroker` (line ~898) closed unions.
- `src/lib/tradier.ts` — NEW gateway adapter (all 9 `BrokerGateway` methods, `request`/
  `trackHealth` helpers, `arr` normalizer, side/type/duration mapping tables,
  `capsFromProfile`).
- `src/lib/broker.ts` — import + `resolveGateway` `activeBroker === "tradier"` branch.
- `src/lib/broker-side.ts` — `"error"` → `TERMINAL_DECLINE_STATES`; `"pending"` →
  `LIVE_ORDER_STATES`.
- `src/lib/broker-held-orders.ts` — `"pending"` → `ACTIVE_BROKER_ORDER_STATES`.
- `src/lib/execution-mode.ts` — `brokerLabel` `"tradier"` → `"Tradier"`.
- `src/lib/dashboard.ts` — `brokerDisplayName` `"tradier"` case.
- `src/lib/strategy.ts` — `brokerLabel(policy)` `"tradier"` case.
- `src/lib/db-api-keys.ts` — the three stale `String(broker) as ...` casts widened to the
  full union incl. `"alpaca-mcp"` and `"tradier"`.
- `app/api/connected-accounts/route.ts` — allow-list + 400 message, Tradier validation +
  explicit environment, defaultLabel, baseUrl ternary.
- `app/console/settings/lib.ts` — `TradierConnectBody` + `connectTradierAccount`.
- `app/console/settings/brokers.tsx` — `brokerName` case, Connect Tradier button, new
  `TradierConnectSheet` (single Access-Token field, Environment select, optional account
  number + tax treatment; live warning only when Production).
- `app/console/components/chrome.tsx` — ScopeSelector `brokerName` `"tradier"` case.
- `app/console/settings/help.tsx` — broker glossary "Tradier via access token".
- `app/settings-search.ts` — `"tradier"` synonym.
- `test/tradier.test.ts` — NEW adapter unit tests (fetch-mocked).
- `test/connected-accounts-route.test.ts` — Tradier sandbox/production/no-token cases.
- `test/execution-mode.test.ts` — Tradier paper/live fixtures.
- `test/broker-side.test.ts` — `isLiveOrderState("pending")`, `isRejectedOrCanceledState("error")`.

## Verification (node@24 on PATH)
- `npm run lint` — 0 errors (grandfathered warnings only).
- `npx tsc --noEmit` — clean.
- `npm test` — 316 files / 3428 tests passed.
- `npm run build` — clean (see gate results in PR).

No Alpaca/Robinhood/test broker behavior changed. No deploy. No live token exercised.

## Fixups from adversarial review (2026-07-10, second pass)

Seven confirmed review findings fixed on this branch. Each has a dedicated regression test; no
Alpaca/Robinhood/test-broker behavior changed. Gates re-run green (node@24): lint 0 errors, tsc
clean, 316 files / 3446 tests, build OK.

1. **[HIGH] Symbol-canonicalization inconsistency (`src/lib/tradier.ts`).** `getEquityPositions`
   left Tradier's dotted share-class tickers (BRK.B) un-hyphenated while orders/quotes hyphenated
   them, so a share-class position never matched its own resting orders/proposals. Added
   `fromTradierSymbol`/`toTradierSymbol` helpers (dot<->hyphen at the wire boundary; canonical
   internal form is HYPHENATED per `money.ts/normalizeSymbol`) and routed ALL read paths (positions,
   orders via `mapTradierOrder`, quotes, tradability) through `fromTradierSymbol` and all writes
   (order symbol, quote request) through `toTradierSymbol`. `getEquityQuotes` now canonicalizes to
   the hyphenated form and aliases the requested form, mirroring Alpaca exactly. Fixed the misleading
   header comment that called dots "our canonical form." Test: a dotted BRK.B from a position, an
   order, and a quote all normalize to the identical `BRK-B`.
2. **[MEDIUM] Market dollar-order share sizing used the stale proposal `referencePrice`.** Tradier
   has no broker-side notional cap, so a rising stock overspent the dollar budget. A LIMIT order now
   anchors on its `limitPrice` (fill-capped, never overspends); a MARKET order sizes from a FRESH
   quote at placement time and THROWS `"cannot size a dollar order without a live quote"` rather than
   fall back to the stale price. `referencePrice` dropped as an anchor entirely. Test: reference 100
   but fresh quote 200 on a $1000 order yields floor(1000/200)=5 shares, never 10.
3. **[MEDIUM] Environment/baseUrl crossing.** The gateway trusted a stored `baseUrl` over
   `environment`, so a paper account with a mismatched baseUrl could route real orders to
   api.tradier.com. The gateway now DERIVES the base URL from `environment` (live=>api, paper=>sandbox)
   and honors a stored baseUrl only when its host matches the environment's venue (else ignores it).
   The connect route (`app/api/connected-accounts/route.ts`) now REJECTS (400) a Tradier `baseUrl`
   whose host doesn't match the selected environment. Tests: paper env never yields an api.tradier.com
   base even with a mismatched stored baseUrl (gateway) + 400 on a host-mismatched connect (route).
4. **[LOW] Dollar-sizing fresh-quote lookup keyed by the wrong form.** Same root cause as #1 — the
   quote-map lookup used `normalizeSymbol(input.symbol)` (dot-preserving) against a hyphenated store
   key. Now `fromTradierSymbol` on both. Asserted explicitly: a dotted BRK.B market dollar order finds
   its fresh quote and sizes off it (floor(1200/400)=3).
5. **[LOW] `sanitizeTag` `_`->`-` broke the synthetic-stop client-order-id dedup.** Tradier's tag
   charset is letters/numbers/dash only, so a raw refId carrying a non-primary `u_<hash>` userId came
   back mangled and never matched the stored refId. Fix keeps the generated synthetic-stop refId within
   the broker-portable `[A-Za-z0-9-]` charset AT GENERATION (`src/lib/synthetic-stops.ts`
   `brokerPortableRefId`), so the tag round-trips byte-identical through Tradier (and any broker) —
   `sanitizeTag` is now identity on every refId we place. Collision-safe (userIds are `local` or
   `u_<24hex>`). Test: a `u_<hash>` synthetic-stop refId placed and read back matches exactly.
   NOTE: Tradier's exact tag charset could not be re-confirmed from the live docs (their new site is a
   JS SPA that WebFetch can't render; archive.org is blocked). The chosen fix is safe REGARDLESS of
   whether Tradier allows underscores — a portable refId contains none either way.
6. **[LOW] Plaintext token field.** The Tradier access-token input
   (`app/console/settings/brokers.tsx`) now renders `type="password"` (masked), matching the Alpaca
   secret field.
7. **[LOW] `cancelEquityOrder` returned Tradier's raw `'ok'` as the state.** No `broker-side.ts` state
   check recognizes `'ok'`. Now normalized to `'pending_cancel'` (a state `isLiveOrderState` treats as
   live — an async cancel can still fill until confirmed dead); a real terminal status passes through
   verbatim. Tests: `'ok'` -> `'pending_cancel'` (recognized live, not terminal); `'canceled'` passes
   through.

### Fixup files touched
- `src/lib/tradier.ts` — findings #1, #2, #3, #4, #7 (+ `sanitizeTag` comment for #5).
- `src/lib/synthetic-stops.ts` — finding #5 (`brokerPortableRefId` + apply at generation).
- `app/api/connected-accounts/route.ts` — finding #3 (reject host-mismatched Tradier baseUrl).
- `app/console/settings/brokers.tsx` — finding #6 (`type="password"`).
- `test/tradier.test.ts` — regression tests for #1, #2, #3 (gateway), #4, #5, #7 (+ updated the
  no-price throw assertion to the clearer message).
- `test/connected-accounts-route.test.ts` — regression tests for #3 (route reject/accept).

## Follow-ups (from SPEC openQuestions)
1. Confirm whole-share-only with a sandbox fractional-quantity preview before trusting the
   floor-or-throw path in production (conservative either way).
2. Native OTOCO equity brackets (leg param names) — deferred; validate with a preview
   submission.
3. Real preview endpoint for `reviewEquityOrder` (`order.cost`/`warnings`/`errors` →
   `preflightBlock`) — v1 self-computes via `estimateReviewNotional`.
4. IRA/Roth agentic-allowed: currently defaults agentic-allowed like Alpaca (no
   `connectedAccountAgenticFallback` clause added). Owner decision.
5. Orders pagination: confirm live `?page`/`?includeTags` behavior and the exact
   `create_date`/`transaction_date` field names.
6. Sandbox orders/positions/balances actually returning data (owner's UI flagged sandbox
   "account activity unavailable"; the REST surface used here is documented to work).
7. Rate-limit backoff on HTTP 429 if strategy-loop volume approaches limits.
8. Optional operator `tradier_access_token` env tier (intentionally omitted; fail-loud).

# 2026-07-11 — Codex PR review fixes (6 P2 items)

## Summary
Responded to 6 P2 findings from the Codex PR reviewer on PR #1380, all in
`src/lib/tradier.ts` and `app/api/connected-accounts/route.ts`. Each was a
clear correctness bug or data-fidelity issue.

## Changes

1. **Resolve Tradier account number during connect**
   (`app/api/connected-accounts/route.ts`). If the user leaves the account
   number field empty, the route now probes the token's `/user/profile` after
   storing the connected account, resolves the real account number, and updates
   the row. Previously a missing account number caused `getPolicy()` to copy
   `undefined` into `policy.accountNumber`, making every strategy run fail with
   "No account selected" before the gateway could probe.

2. **Read PDT buying power** (`src/lib/tradier.ts` `getPortfolio`). Added
   `pdt.stock_buying_power` as the preferred buying-power field for margin
   accounts — Tradier returns it for pattern-day-trader accounts, separate from
   `margin.stock_buying_power`. Previously buying power for PDT margin accounts
   was understated, potentially shrinking sizing/funding checks.

3. **Filter non-equity orders** (`src/lib/tradier.ts` `getEquityOrders`). Added
   a `class === "equity"` filter before pushing each row, so option/combo/
   multileg orders are never mapped as `EquityOrder`. Previously they polluted
   dashboard order state with coerced sides/types.

4. **Canonicalize position symbols** (`src/lib/tradier.ts`
   `getEquityPositions`). Position symbols now use `.replace(/\./g, "-")` to
   match the hyphenated canonical form (BRK-B) that `getEquityQuotes` uses as
   keys, fixing a quote-lookup mismatch for share-class symbols like BRK.B.

5. **Keep short average costs positive** (`src/lib/tradier.ts`
   `getEquityPositions`). Changed `totalCost / quantity` to
   `totalCost / Math.abs(quantity)` so short positions (negative quantity) get
   a positive average cost. Risk paths treat `averageCost <= 0` as unusable.

6. **Avoid double-counting option value as equity** (`src/lib/tradier.ts`
   `getPortfolio`). Changed `equityMarketValue` from `market_value` (which
   includes option value) to `stock_long_value - stock_short_value` with a
   fallback to `market_value - optionMarketValue`. Previously
   `accountEquity()` added option value twice for mixed stock/options accounts,
   inflating drawdown breakers and dashboard invested values.

## Files
- `app/api/connected-accounts/route.ts` — `const`→`let` for accountNumber;
  profile-probe block after upsert.
- `src/lib/tradier.ts` — PDT buying power (pdt), non-equity order filter,
  position symbol canonicalization, short average cost abs(), stock-specific
  equity market value.
- `test/tradier.test.ts` — Added `class: "equity"` to order mock fixtures.

## Verification
- `npm run lint` — 0 errors.
- `npx tsc --noEmit` — clean after `npm run build`.
- `npm test` — 316 files / 3433 tests passed.
- `npm run build` — clean.
