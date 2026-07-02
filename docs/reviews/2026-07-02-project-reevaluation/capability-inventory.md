# Capability Inventory — Agentic Trading Platform

This document inventories what the product *does* — its capabilities, data, constraints, and user jobs — with no reference to any existing presentation. It is written so a designer who has never seen the product can design an interface from first principles. All field, state, and command names below are the real names used by the server code and its HTTP API; they are the contract an interface must speak.

---

## 1. Product one-liner and personas

**One-liner:** A self-hosted agentic equity-trading system in which an LLM strategist scans the market, argues with an adversarial reviewer, and proposes or places stock trades inside a hard deterministic policy cage — across simulated, broker-sandbox, and real-money accounts — while a learning loop measures every decision (including the ones it didn't take) and a human retains final authority over anything that touches real capital.

### Personas and jobs-to-be-done

**A. Novice retail user (cautious delegator).**
Jobs:
- "Let an AI trade a small account for me, but never let it hurt me." Needs an unmistakable answer at all times to: *is this real money?*, *is the agent armed?*, *what can it spend?*
- Review and approve/reject individual trade recommendations, each with a plain-language rationale, a thesis tag, an estimated dollar amount, and how the idea has performed since it was proposed.
- Set simple guardrails (per-order dollar cap, daily cap, stop-loss %, take-profit %) without understanding the ~50 underlying policy fields; sensible safe defaults exist for all of them.
- Get notified on their phone when something fills, gets blocked, needs approval, or a circuit breaker trips.
- Ask questions in natural language ("what's my P&L?", "why did you buy NVDA?", "alert me if AAPL drops below 200") and get grounded answers or reversible actions.
- Run everything in the free local simulator (Test) indefinitely before ever connecting a broker.

**B. Multi-account power operator.**
Jobs:
- Run several connected brokerage accounts (e.g. an Alpaca paper sandbox, a live taxable Robinhood account, a Roth IRA) each with its **own independent policy, prompt, cadence, arming state, and authority level**; arm/disarm each separately.
- Maintain a library of reusable strategy presets and copy one onto any chosen account without accidentally arming it.
- Tune the machine: scoring-factor weights, thesis playbook performance, regime-conditioned behavior, confidence calibration, opt-in autonomous weight tuning with statistical gates, and dozens of `tuning.*` knobs — all default-off/no-op.
- Audit everything: per-run decision records, the full scored candidate set (chosen *and* skipped), counterfactual returns on rejected ideas, wash-sale exposure, tax lots approaching long-term treatment, and an append-only audit event stream.
- Perform the deliberate, friction-full ritual required to approve a real-money order (typed confirmation) and to enable real-money autonomy.
- Manage per-provider API keys (their own or operator-supplied), watch provider health, and control data-sharing consent.

**C. System admin / operator (the deployment owner).**
Jobs:
- Govern multi-user access: verified-email identity, a primary-operator account, an admin email allowlist (`ADMIN_USER_EMAILS`), and the guarantee the owner can never be locked out.
- Meter cost: per-user, per-key LLM token/cost ledger (`llm_usage`), RAG usage ledger (`rag_usage`), spend on the operator's fallback key by non-owning tenants ("operator-funded" usage), and an external usage/budget monitor with alert thresholds.
- Watch platform health: per-service, per-credential-lane API health log with consecutive-failure detection and error-pattern clustering; scheduler liveness heartbeat; readiness/health endpoints; a token-protected remote ops snapshot for off-box diagnostics.
- Operate content pipelines: re-index SEC 10-K/10-Q and 8-K corpora, force web-source refreshes, import securities reference data, probe broker connectivity, dry-run the tuner, run factor-IC backtests, evaluate the congressional-signal gate.
- Emergency control: halt any account, rely on the boot interlock that disarms autonomy after any restart, and know that no background process resumes real-money trading without explicit human opt-in.

---

## 2. Core domain objects

### 2.1 User
- Identified by a stable `userId` derived from a **verified email** (middleware verifies the session and forwards a trusted `x-authenticated-user-email` header; client-supplied identity is never trusted). The primary operator's email (plus configured aliases) maps to the legacy `"local"` id; every other user gets an opaque hashed id with fully isolated data.
- Per-user assets: connected accounts, policies, strategy profiles, runs, proposals, fills, snapshots, watchlist, price alerts, notification preferences, chat history, memory, learned context, API keys, usage ledgers, audit events.
- **Data-pool consent** (`consent.set`, `getDataPoolConsent`): opt-in reciprocal sharing of market data fetched with the user's own API keys into a shared cache pool.
- **Account deletion** is a two-step flow (request → confirm) requiring the exact typed phrase `DELETE MY ACCOUNT` (`DELETE LOCAL OPERATOR ACCOUNT` for the operator), with a preview of what will be deleted (counts across ~24 tables, connected accounts) and blockers (running strategy runs, in-flight `placing` proposals, `pending_reconciliation` fills) that must clear first.

### 2.2 Connected account
`ConnectedAccount`: `broker` (`"alpaca" | "alpaca-mcp" | "robinhood" | "test"`), `environment` (`"paper" | "live"`), `label`, `accountNumber`, encrypted `apiKey`/`apiSecret` (AES-256-GCM at rest), `isActive` (exactly one active per user), `taxationType` (legacy) and a **capabilities snapshot** populated from the broker on connect:
- `AccountCapabilities`: `equityTrading`, `shortSelling`, `optionsTrading` (+ `optionsLevel` 0–4), `futuresTrading`, `cryptoTrading`, `marginEnabled` (+ `marginRequirementPct`), `accountType` (`"brokerage" | "traditional_ira" | "roth_ira" | "crypto_exchange"`). **Every capability defaults to false when absent** — an unpopulated account is never granted a power the broker hasn't confirmed.
- Brokers also report per-account `agenticAllowed`; autonomy cannot be armed on an account that isn't.
- Robinhood connects via an OAuth consent flow (server stores OAuth state/tokens); Alpaca via API keys; `test` is the built-in local simulator (always available, no credentials).
- Each account carries its own live strategy state (see 2.4) and its own scheduler clock — accounts of the same user run independently and never block each other.

### 2.3 Money-reality (execution mode)
Derived, never guessed: `deriveExecutionState(policy, activeAccount)` yields one of three modes with **word labels**:
- `test/local` → label **"Test"** — the app's local simulator: configurable starting cash (`paperStartingCash`, default $10,000), simulated fills marked to live prices. Explicit clarification text: it is *not* any broker's paper account.
- `broker/paper` → label **"Paper"** — a broker-hosted sandbox (e.g. Alpaca Paper). Real broker endpoints, no real capital.
- `broker/live` → label **"Brokerage"** — a production broker account. Orders can reach real capital only when policy, approval, and risk gates all allow it.
Every fill, proposal, snapshot, and run row is stamped with its `executionMode`, and P&L is bucketed by `FillSource` (`"live" | "paper"`). Test and Paper both book to the `paper` bucket; only `broker/live` books to `live`.

### 2.4 Trading policy (per account)
`TradingPolicy` is the deterministic rulebook. Fields grouped by purpose (real names):

- **Run state & authority:** `systemState` (`"active" | "halted" | "close_only" | "liquidating"`), `strategyAuthority` (`"propose" | "decide"`), `runCadenceMinutes` (default 60), `runDuringExtendedHours`, `holdingHorizon` (`"intraday" | "swing" | "position" | "longterm"`).
- **Universe:** `includedIndices` (any of `sp100, sp500, nasdaq100, nasdaqComposite, dow30, russell2000, nyseComposite, ftWilshire5000`), `additionalSymbols` (explicit allowlist), `blocklist`, `universeFloor` (`minPrice` default $5, `minMarketCapUsd` default $100M, `minDollarVolume` default $1M — an *opening-eligibility* filter only; explicit symbols and held positions are always exempt, exits never affected).
- **Order-size caps:** `maxOrderNotional` (hard clamp ≤ $100k), `maxOrderPctOfNav` (default 5%), `maxDailyNotional` (default $500; clamped if absurd), `maxDailyPctOfNav`, `maxHourlyNotional` (rolling 60-min ceiling; **breach auto-reverts the account to "propose" authority**), `maxDailyOrders` (default 10, opening orders only), `maxProposalsPerRun` (default 3).
- **Exposure caps:** `maxSymbolExposurePct` (default 25%), `maxSymbolExposureNotional`, `sectorCaps` (per-sector % map), `maxGrossExposurePct` (default 80%), `maxNetExposurePct` (default 80%), `maxPortfolioBeta`, `maxAvgCorrelation` (correlation-cluster gate), `maxOrderPctOfAdv` (default 5% of a name's daily dollar volume — market-impact cap).
- **Entry-quality gates:** `maxEntryDriftPct` (default 10% — rejects a stale opening market/dollar order whose price moved from the recorded `referencePrice`), `maxQuoteAgeSec` / `maxFundamentalsAgeSec` (opt-in staleness gates: stale or missing timestamp ⇒ block opening orders, never exits), `permittedOrderTypes` (`market, limit, stop_market, stop_limit`; default market+limit), `permitExtendedHours`, `marketableLimitEntries` (+ `tuning.marketableLimitBufferBps`).
- **Risk rules (`riskRules`):** `stopLossPct` (default 8), `stopLossNotional`, `takeProfitPct` (default 20), `takeProfitTrimPct` (default 50 — partial, laddered trims per profit band), `takeProfitNotional`, `trailingStopPct`, `shortStopLossPct` (mandatory for any short), `atrStopPeriod`/`atrStopMultiple` (with `atrStops` toggle), account-level circuit breakers `maxDrawdownPct` and `maxDailyLossNotional`.
- **Stops plumbing:** `brokerBracketsEnabled` (default on — broker-held OCO stop/take legs on brokers that support them), `robinhoodBrokerStops` (opt-in true resting broker stop for live Robinhood), `betaScaledStops` (stop distance scaled by beta, clamped 0.5–2.0×), `allowExtendedHoursSyntheticStops`.
- **Panic brake:** `volPanicBrakeEnabled` (default on) with `volPanicVixThreshold` 40 / `volPanicVvixThreshold` 150 / `volPanicSkewThreshold` 160 — a tail-extreme reading flips `active → close_only`.
- **Short selling:** `shortSellingEnabled` (default off; also requires broker `shortSelling` capability), `maxShortOrderNotional`, `maxShortExposurePct`.
- **Sell-to-fund:** `sellToFundBuy` (`"off" | "suggest" | "propose" | "automated"`, default off).
- **LLM config:** `llmModel` (default `gpt-5.4-mini`), `redTeamLlmModel`, `llmReasoningEffort` (`low|medium|high`).
- **Proposal hygiene:** `proposalExpiryMinutes` (default 2880 — hard TTL after which a pending proposal auto-expires), `proposalRevalidateCadenceHours` (LLM re-check cadence, default 0 = every run), `staleLimitOrderMinutes` (default 15 — alert on a limit order still working).
- **Scan shape:** `scoringWeights` (8 factors, below), `marketScanCandidateLimit`, `marketScanOutlierReserve`.
- **Tax (`taxSettings`):** `taxationType` (`taxable | roth_ira | traditional_ira`), `washSaleGuard` (default true), `shortTermRatePct` (default 24), `longTermRatePct` (default 15), `subtractFromResults` (show P&L net of estimated tax).
- **Notifications (`notificationSettings`):** `webhookUrl`, `enabledEvents` — subset of `fill, block, run_failed, pending_approval, kill_switch, price_alert, proposal_withdrawn, limit_order_stale, provider_degraded, budget_alert`.
- **Tuning (`tuning.*`):** ~30 expert knobs, all safe-by-default: `shrinkPrior`, `minClosedLotsForWeightShift` (20), `sizingFloorPct`/`sizingCeilingPct`, `redTeamConvictionThreshold` (80), `crisisMaxOpeningExposurePct`, `convictionCapUncorroborated` (0.6), `corroborationWinRatePct` (58), `bearVetoFcfYieldFloorPct`, `bearVetoDebtToEquityCeiling`, `skipNegativeExpectancy` (+edge threshold), `oosWithholdUnvalidated` (default **true** — strip statistically unvalidated weight changes), `minProposalScoreThreshold` ("do nothing" floor), and the autonomous-tuning family: `autoApplyWeights`, `minOosICImprovement`, `minOosPairedTStat`, `autoApplyOverrideUnvalidated`, `autoApplyDrawdownGuard`, `minOosTestDates`, `shadowWeightLedger`, `oosPurgeEmbargo`, `congressGoNoGoGating`, `congressRequireTopBucketPositive`, `missedOpportunityNudge`, `benchmarkRelativeMisses`, `missedOpportunityRequireHitRate`, `recurringFactorMinCount`, `calibrationSizing`, `perRegimeWeights`, `icWeightShrinkage`, `useEntryRunAttribution`.

Policy storage is tiered: most fields are **account-scoped** (`account_strategy_state`), while a small set is **user-scoped** and overlays every account (`notificationSettings`, `marketScanCandidateLimit`, `marketScanOutlierReserve`).

### 2.5 Strategy prompt & profiles
- Each account runs a free-text **strategy prompt** (objective, selection logic, sell/trim rules, sizing guidance, output contract) alongside its policy and scoring weights. A rich default prompt ships with the product.
- `StrategyProfile` is a named, user-level **library preset**: `{name, policy, prompt, scoringWeights, active}`. Create / update / delete / activate; deleting the active one promotes the oldest remaining.
- **Copy semantics:** activating a profile copies it into the *active* account's live state; `applyProfileToAccount(profileId, connectedAccountId)` copies it onto any *chosen* account. Both are **copy, not link** — later edits to the library never retro-mutate an account — and provenance is stamped (`derived_from_profile_id`). **Safety:** applying a profile always preserves the target account's current `systemState`; a preset can never arm (or disarm) autonomy.

### 2.6 Proposals and lifecycle
`TradeProposal`: `symbol`, `side` (`buy | sell | short | cover`), `type`, `quantity` or `dollarAmount`, `limitPrice`/`stopPrice`, `timeInForce` (`gfd|gtc`), `marketHours` (`regular_hours|extended_hours|all_day_hours`), required `rationale`, required `tradeThesisTag` (bounded vocabulary — see 3.4), required `entryMarketRegime`, `confidenceScore`, `referencePrice` (decision-time price anchor), bracket fields (`bracketTakeProfit`, `bracketStopLoss`, `bracketStopLimit`), take-profit-trim bookkeeping (`takeProfitBand`, `takeProfitBasis`).

**Lifecycle statuses** (persisted on `trade_proposals`): `proposed` (awaiting human) → `placing` (durable pre-broker intent with idempotency `refId`) → `placed`; or `paper` (simulated fill); or `blocked` (failed a gate, with machine-readable `reasons[]`); or `rejected` (human said no); `expired` (hard TTL); `withdrawn` (LLM re-validation said the idea no longer holds); `placing_failed` (broker call failed/uncertain — needs reconciliation); `rejected_by_broker` (broker synchronously declined). Pending proposals carry `lastRevalidatedAt` + `revalidationNote`, and every proposal exposes `performanceSinceProposalPct` (side-adjusted move from `referencePrice` — for a rejected idea this is the realized counterfactual "what it did after we passed").

### 2.7 Orders, fills, positions, portfolio
- `EquityOrder` (from the broker): id, symbol, side, type, state, quantities, `clientOrderId` (our idempotency key — used by broker-truth reconciliation).
- `FillEvent`: proposal/run linkage, `source` (`live|paper`), `executionMode`, symbol/side/quantity/price/notional, status (`filled` | `pending_reconciliation`), `brokerOrderId`, later-annotated `mae`/`mfe` excursions.
- `EquityPosition`: symbol, quantity (negative = short), averageCost, marketValue, sector/industry.
- `Portfolio`: totalMarketValue, buyingPower, cash, equity/option market value.
- `PortfolioSnapshot`: full account state persisted before and after every run (equity curve raw material).
- Order controls beyond placement: cancel a working order; **replace a stale limit order with a market order**.

### 2.8 Runs
`StrategyRunRow`: id, timestamps, status (`running|completed|failed`), human-readable `summary`, per-account linkage, and counts (`placedCount, paperCount, blockedCount, proposedCount, totalCount`). Each run also persists rich audit payloads: `candidates_considered` (chosen vs top skipped), `signal_snapshot` (full per-candidate evidence digest `CandidateEvidence` for the entire scored set — factor breakdowns, provenance, decision-time prices, regime), `rationale_diversity` (template-collapse detector), plus every gate/breaker event.

### 2.9 Alerts and notification events
- `PriceAlert`: symbol, `op` (`<` or `>`), price, note, status `armed → triggered` (with trigger time/price). Evaluated every scheduler tick against live quotes.
- `NotificationEvent`: in-app record of each dispatched event (type, title, payload, `sent|failed|skipped`).
- `NotifyPrefs`: per-user out-of-app channels (`push` via ntfy or Pushover, `webhook`, `email` via Resend, `sms` via Twilio) each with its own target; channel availability depends on server config, and a channel descriptor API tells clients which channels are usable and what target field each needs. A test-notification action exists.
- Server push: an SSE event stream carries `dashboard.run-complete`, `dashboard.proposal`, `dashboard.order`, `dashboard.market-data`, `dashboard.dirty`, and `mobile.command` events so clients refresh instantly.

### 2.10 Learned context, memory, and learning ledger
- `LearnedContextRow`: durable learned **facts** (`scope` private/shared, `kind` pattern/decision/fact, subject, optional symbol, value, `origin` chat/autonomous/ingest, `riskTier` fact/risk/strategy-directive, confidence, supersession, expiry). Reaches the strategy brain **only as advisory prompt text** — never as a numeric input to sizing or scoring (a regression test guards this invariant). A risk classifier is the single chokepoint; anything not clearly a non-risk fact **fails closed to 'risk'**.
- `LearnedContextPendingRow`: risk-tier candidates from autonomous/ingest producers queue for **explicit human approve/reject**; approval applies them safely (advisory only) and never auto-derives a numeric policy change.
- `MemoryItem`: salience-gated per-user memory from chat (kinds: constraint, preference, goal, correction, pattern, decision, oneoff; WRITE/HOLD/SKIP decisions; supersession).
- `learning_mutations`: an append-only ledger of every machine-applied learning change (e.g. scoring-weight applies) with prior-state snapshots enabling **revert**.

### 2.11 Tax data
`TaxSummary` (estimates only, clearly not tax advice): tax year, `shortTermRealized` / `longTermRealized` (YTD, wash-sale-disallowed losses excluded), `disallowedWashSaleLoss`, estimated ST/LT tax and total `estimatedTaxLiability`, `washSales[]` flags, `lockedSymbols[]` (currently in 30-day wash-sale lockout), `openLots[]` (per lot: daysHeld, `daysToLongTerm`, `isLongTerm`, unrealizedGain, `earlyExitTaxPremium` — the extra tax cost of selling now vs waiting for long-term treatment), `harvestCandidates[]` (open loss positions ranked by unrealized loss). IRA accounts zero the rates and skip the per-account guard automatically.

### 2.12 Market scan and macro data
- `MarketScan`: `source` (a `+`-joined list of every provider that actually contributed this run — never hardcoded), `generatedAt`, `scannedSymbols`, `returnedQuotes`, `candidateLimit`, `outlierReserve`, `outlierCandidateCount`, `breadthPct` (% of the full screener advancing — risk-on/off gauge), `topCandidates[]` (fully enriched `MarketQuote`s), `sectorBySymbol`, `quotesBySymbol` (compact summaries), cache metadata, `warnings[]`.
- `MarketQuote` enriched fields: price/bid/ask/vwap/volume/marketCap, intraday change, sector/industry, composite `score` + `factorBreakdown`, news `sentiment`, `peRatio`, `eps`, `dividendYield`, `pbRatio`, `analystRating`/`analystScore`/`analystBySource` (per-provider breakdown), price targets (`targetMean/High/Low/Median`), `shortPercentOfFloat`, `beta`, 52-week range, `insiderSentiment`, `fcfYield`, `debtToEquity`, `epsGrowth`, `senateTrades` and the composite congressional score family (`congressCompositeScore/SignedScore/Direction/Confidence/Components/Provenance`), `daysToEarnings`, `institutionOwnershipPct`, option-derived `nearTheMoneyIv`/`putCallRatio`, in-house `sectorRelStrength`, bar-based `technicalScore`/`technicalDirection`/`technicalSignals[]`, `evidenceBulletins[]`, and **per-field provenance** `sources` (which provider supplied each value).
- Scoring: 8 weighted factors — `liquidity, momentum, value, quality, volatility, sentiment, positioning, diversification` (defaults 1.4/1.2/0.8/0.8/0.8/0.6/0.8/1.0).
- Macro (`MacroData`, FRED-sourced with dated fallbacks): fed funds, 3-mo/2-yr/10-yr treasuries, 10-yr breakeven inflation, CPI, core PCE, real GDP, unemployment, initial claims, M2 + growth, HY credit spread, USD index, WTI oil, housing starts, consumer sentiment, VIX and VIX3M — plus derived curves and a deterministic **market regime** label used everywhere (`entryMarketRegime`, crisis/inverted detection).
- Market internals: Cboe VIX/VVIX/SKEW, CFTC positioning, Fama-French factors, index breadth.

### 2.13 Chat / assistant
A conversational assistant over the user's own account state with a **strict tool registry** (the model may call only these): `get_quote`, `draft_order`, `create_alert`, `kb_search` (RAG over ingested filings/research), `watchlist_add`, `get_positions`, `get_portfolio`, `list_watchlist`, `list_alerts`, `list_open_proposals`, `get_fundamentals`, `get_market_signals`, `get_portfolio_pnl`, `get_performance_summary`, `get_reflection`, `get_earnings_calendar`, `get_option_chain`, `search_instrument`. **There is no execution tool.** `draft_order` produces a draft ticket only; a separate promotion step converts a draft into a canonical `proposed` trade proposal (buy/sell only — never short/cover) that flows through the exact same approval/policy/execution rail as everything else. Chat history is persisted per user with redact-on-write for secrets/PII and per-turn model attribution; multiple LLM providers are selectable.

### 2.14 Admin surfaces
Token/email-gated endpoints: per-user LLM usage & cost (with operator-funded isolation and per-key masking), RAG coverage, connections health (per service, per credential lane, raw log + error patterns), web-source refresh, 10-K/8-K re-index, securities import, Robinhood connectivity probe, tuning dry-run, factor-IC backtest, congress-score evaluation and daily data-share job, test event/trigger emitters, and a token-authenticated ops snapshot (`x-ops-token`) exposing per-account run state, recent runs, and notable audit kinds for remote diagnosis.

### 2.15 Mobile command set
A durable, idempotent command queue (survives restarts; per-user `idempotencyKey` dedup; statuses `queued → running → succeeded/failed/cancelled`; results/errors persisted; SSE progress events). Command catalog:
`strategy.run_once`, `strategy.start`, `strategy.stop`, `strategy.close_only`, `strategy.liquidating`, `proposal.approve` (accepts a live-confirmation payload), `proposal.reject`, `account.activate`, `watchlist.add`, `watchlist.remove`, `alert.create`, `alert.delete`, `policy.patch` (strictly validated field allowlist; **cannot** change `paperMode`, account bindings, or secrets), `consent.set`, `notification.test`.
Companion endpoints: bootstrap (control catalog + auth model), snapshot, readiness (has account? has universe? state/authority/backlog), events (SSE), and the two-step typed account deletion. Secrets never live on the phone — session token only.

---

## 3. Capabilities (exhaustive)

### 3.1 Autonomy: run-once vs scheduled; propose vs decide
- **Manual run-once**: always available; bypasses the market-closed guard and the halted check, but is **forced to "propose" authority** — a manual run can never place autonomously.
- **Scheduled runs**: a 60-second scheduler tick evaluates every user × connected account independently; an account runs when its own `systemState === "active"`, its cadence has elapsed, and market hours allow (`runDuringExtendedHours` widens the window; holidays/weekends skip). Cadence clocks are rehydrated from the last real run so restarts never fire immediate runs. Bounded concurrency (3 simultaneous account runs).
- **Event-driven triggering** (optional engine, default off): material events (SEC 8-K, regime flip, technical signal, insider/congress disclosures) are deduped, coalesced over a debounce window, gated by market hours + cooldowns + hourly/daily caps, then fire one run. Modes `interval | event | both`.
- **Authority levels:** `propose` — every surviving idea is queued for human approval; `decide` — the agent may place orders itself, still subject to every deterministic gate, and specific categories (funding sells in `propose` sub-mode, high-conviction trades whose required adversarial review couldn't run) are forcibly downgraded to human approval.

### 3.2 The run pipeline (what one strategy session does)
1. Per-account run lock (also serializes against manual approvals — a TOCTOU guard on daily/hourly caps).
2. Reconcile pending broker fills; broker-truth sweep of stale `placing` intents (match by `clientOrderId`, recover or flag).
3. Fetch accounts/portfolio/positions/orders; verify the selected account exists and is `agenticAllowed`.
4. Pre-run portfolio snapshot (crash-safe baseline).
5. **Circuit breakers:** trailing-drawdown (`maxDrawdownPct` from the equity high-water mark) and daily-loss (`maxDailyLossNotional`) breach ⇒ `systemState → close_only` + kill-switch notification. Independent **volatility panic brake** on VIX/VVIX/SKEW extremes ⇒ same.
6. Proposal hygiene: hard-expire stale pending proposals; LLM re-validation of the rest on cadence (regular hours only) — withdraw what no longer holds, stamp survivors.
7. Market scan (see 3.5) + broker quote merge; wash-sale lockout set computed.
8. Proactive risk exits generated deterministically: stop-loss / take-profit / trailing-stop exits, plus **laddered partial take-profit trims** (one trim per profit band; the band ratchet advances only on an actual fill, so an unapproved trim re-offers next run).
9. Advisory context assembled: RAG chunks from filings (relevance-floored), learned-context facts (advisory only), macro, market internals, holdings, recent orders, remaining caps.
10. "Do-nothing" gate: if `minProposalScoreThreshold` filters out every candidate, the LLM call is skipped entirely (audited).
11. **Bull proposer LLM** emits proposals (strict JSON contract; thesis tag from the fixed playbook; no LLM credential ⇒ hard failure, never a fabricated fallback).
12. Optional negative-expectancy skip; **deterministic sizing** (conviction-scaled between `sizingFloorPct` and `sizingCeilingPct`, corroboration-capped, optionally calibration-remapped, ADV-capped); opening enrichment (reference price, brackets).
13. **Red Team debate** for high-conviction proposals (`confidenceScore ≥ redTeamConvictionThreshold`, default 80): a bear-side LLM tries to kill the idea. Rejected ⇒ dropped; **unavailable ⇒ fail closed** — the trade is routed to human approval instead of auto-executing.
14. Sell-to-fund-buy planning per `sellToFundBuy` mode (never sells names being traded this run).
15. Correlation-cluster gate (skip opening a name too correlated with current holdings; never blocks exits; skips rather than false-rejects on thin data).
16. Per-proposal execution loop: tradability check → broker order review (estimated notional) → **the full deterministic policy gate** (see 3.6) re-evaluated with fresh daily/hourly stats → route by status: blocked (notify + counterfactual-record if opening), proposed (queue + notify), paper (simulated fill), or placed (durable `placing` intent with idempotency `refId` → broker call → synchronous-decline detection → fill record `filled` or `pending_reconciliation`). Every placement is isolated so one broker outage can't abort the run's remaining risk exits.
17. Evidence persistence: full `signal_snapshot` (chosen **and** skipped candidates), `candidates_considered`, rationale-diversity check; skipped-candidate counterfactual materialization kicks off async.
18. Post-run snapshot, run summary, post-mortem reflection trigger, dashboard SSE event, and (opt-in) cadence-gated autonomous weight tuning.

### 3.3 Approval flow (human in the loop)
- Approving re-runs *everything server-side at approval time*: fresh scan, fresh broker review, fresh policy gate (including entry-drift vs the stored `referencePrice`, staleness gates, wash-sale set, caps with current usage, PDT count for live). A proposal whose account or execution mode no longer matches the current selection is refused ("re-run the strategy before approving").
- **Typed live confirmation:** approving a `broker/live` proposal requires a `LiveApprovalConfirmation` payload matching the proposal id, account number, execution mode `broker/live`, the reviewed `estimatedNotional` (±$0.01), and the exact typed text **`APPROVE LIVE <SYMBOL>`**. Any mismatch throws a structured `LIVE_CONFIRMATION_REQUIRED` error carrying the reasons and the expected text (so a client can render the challenge). Test/Paper approvals need no typed text.
- Concurrency safety: the approval takes the same strategy lock as the run loop, then re-asserts the proposal is still `proposed`, then an **atomic compare-and-swap** flips it to `placing`/`paper` so double-clicks, two sessions, or a concurrent run can't double-place.
- Rejection records the decision and feeds the idea into the counterfactual pipeline — the system keeps scoring what you turned down.

### 3.4 Thesis playbook & regimes
Every trade carries exactly one thesis tag from a **fixed vocabulary** (bounded so scorecards accumulate samples): `Momentum-Breakout, Mean-Reversion, Value-Quality, Earnings-Catalyst, Analyst-Revision, Insider-Accumulation, Short-Squeeze-Risk, Defensive-Rotation, Sector-Relative-Strength, Risk-Exit` (plus system tags `Sell-to-Fund`, `Manual-Chat`). Every trade also stamps the deterministic market regime at entry (and at exit), enabling thesis × regime learning.

### 3.5 Market scan, enrichment cascade, provenance
- **Base universe:** a public delayed exchange screener (thousands of names) intersected with the policy's `includedIndices` + `additionalSymbols` − `blocklist`, filtered by `universeFloor`. Ranked by the 8-factor composite; the top `marketScanCandidateLimit` receive expensive enrichment, with up to `marketScanOutlierReserve` below-cutoff slots reserved for names with **notable cached web signals** (≥2 distinct congressional buyers with positive net flow, strong insider buying, short-pressure, or strong bullish technicals).
- **Enrichment cascade (first non-null value wins per field):** Finnhub (keyed) → FMP (keyed) → **Yahoo Finance (no key — always the final real tier)**, plus broker quotes (Alpaca/Robinhood), streamed news headlines, an opt-in Robinhood option-chain tier (IV, put/call), opt-in FMP price targets, and shared congressional data. Each keyed provider exists only when its key is configured.
- **Provenance rules (hard):** every enriched value records which provider supplied it (`sources` per field); the scan's `source` string is derived from what actually ran; synthesized bid/ask are flagged (`syntheticSpread/Bid/Ask`) and never treated as real spreads; **real data is never labeled mock/fallback, and missing data is never faked** — `"n/a"` means a real computed no-ratio state (e.g. negative earnings P/E), `"-"` means the datum simply wasn't available; the two are not interchangeable.
- **Web-source evidence layer** (cadence-gated background refresh, independent of trading): congressional trade disclosures (+ an analytics composite with direction/confidence/provenance), insider sentiment, FINRA short-volume, SEC 8-K/10-K/10-Q ingestion into a vector store (RAG), and bar-based technicals (webhook-pushed or computed in-house), each distilled into one-line evidence bulletins.
- Caching is scope-aware: env-keyed/free data is shared; user-keyed data is private, or pooled when the user consents.

### 3.6 The deterministic policy gate (every order, every path)
Evaluated server-side for autonomous placements, human approvals, chat-promoted drafts, and synthetic-stop exits alike. Checks (each producing a human-readable reason): system-state gating (see 3.7); account selected; universe/blocklist membership (**opening only** — never blocks an exit); permitted order types; extended-hours permission; fractional/dollar-order constraints; entry-drift (`maxEntryDriftPct`); quote/fundamentals staleness gates; short-selling enablement + broker capability + mandatory `shortStopLossPct` + `maxShortOrderNotional` + `maxShortExposurePct`; cover-vs-short-holdings sanity; live margin-account minimum equity ($2,000, FINRA notice-based) and PDT day-trade counting (live only); per-order caps (`maxOrderNotional`, `maxOrderPctOfNav`) plus a 5% execution-headroom buffer; ADV market-impact cap; daily/hourly notional caps and daily opening-order count; buying-power affordability; sell/cover quantity vs holdings; size-less exit rejection (an exit must carry a quantity or dollar amount); crisis-regime opening-exposure cap; **wash-sale lockout** (buys only); per-symbol %/notional caps; gross/net portfolio exposure caps; sector caps; portfolio-beta cap (risk-reducing trades always pass); and per-position stop-loss/take-profit "don't add to a loser/winner" rules (beta-scaled when enabled). Closing sides never consume the daily caps and can never be blocked by exposure caps — an exit is sacred.

### 3.7 System states, kill/halt semantics, arming
- `halted` — **the only no-order state.** No runs, no autonomous orders, no synthetic-stop exits, approvals refused. Halting **never sells anything**: it freezes, it does not liquidate.
- `close_only` — no new entries; risk-reducing exits (sell/cover) still flow, the synthetic-stop monitor keeps running, and pending exits can be approved. This is the state circuit breakers and the panic brake set automatically.
- `liquidating` — only close orders allowed; a deliberate human-set wind-down state.
- `active` — full operation under the account's authority level.
- **Arming preconditions** (server-enforced): an account must be selected, a non-empty universe configured, and the broker must report the account `agenticAllowed`.
- **Boot reset interlock:** on process start, every account left `active` is reverted to `halted` (audited) unless the user opted into `autoResumeOnBoot` (or the global `AUTONOMY_RESUME_ON_BOOT=1` override) — a restored database or crash-loop can never silently resume real-money autonomy. `close_only`/`liquidating` are left as-is (they are already safe states).
- **Auto-revert:** breaching `maxHourlyNotional` flips `strategyAuthority` back to `propose` in addition to rejecting the order.

### 3.8 Protective exits
- **Broker-held brackets** (default on where supported): stop-loss + take-profit legs rest at the broker so protection survives app downtime.
- **Synthetic trailing-stop monitor**: every scheduler tick, in all states except `halted`; high/low-watermark trailing with bad-tick rejection (>10% deviant prints ignored), extended-hours opt-in, atomic claim so concurrent ticks can't double-fire, and coordination with resting broker stop legs (skip synthetic exit when a live broker stop exists; cancel orphaned broker stops when a position closes).
- **Robinhood live resting stops** (opt-in): a true broker-side GTC stop-market maintained per open live position.
- **Stale-limit-order alerts** and one-action **replace-with-market**; order cancel.
- Stops sizing intelligence: flat %, beta-scaled, or ATR-based distances.

### 3.9 Wash-sale cross-account lockout
A loss realized on a long position in any **taxable** account locks *buys* of that symbol across **all** the user's accounts — including IRAs — for 30 days (IRC §1091 + Rev. Rul. 2008-5 semantics: an IRA replacement purchase permanently destroys the disallowed basis). Losses inside an IRA create no lockout. The gate resolves the locked set itself if a caller doesn't supply it (cannot be bypassed by omission); covers are exempt (they don't re-establish the long). `washSaleGuard` can be disabled per account; IRA accounts disable it automatically. The tax summary surfaces the currently locked symbols and already-detected wash sales with disallowed-loss dollar amounts.

### 3.10 Performance & tax analytics
- Dual-bucket equity curves (live vs paper) from run snapshots; realized/unrealized P&L, win rates, average return per bucket.
- **Benchmark comparison:** the account's curve vs an SPY buy-and-hold curve normalized to 100 at the first common date, with account/benchmark/excess total returns — degrades to absent (never fabricated) on insufficient data.
- Per-run attribution (`RunAttribution`) with dual credit: P&L keyed to the exit run and, additively, to the entry/decision run.
- Scorecards: by thesis, by regime, by thesis × regime, by sector; **signal efficacy** (which decision-time evidence preceded wins); **factor scorecard** (per-factor realized IC); **confidence calibration** (stated confidence band vs realized win rate).
- **Counterfactual analytics:** skipped top candidates and rejected/blocked proposals are tracked from their decision-time `refPrice`; matured returns feed missed-opportunity summaries (optionally benchmark-relative) and, opt-in, a small clamped per-run scoring nudge.
- MAE/MFE excursion stats per thesis (pain endured vs move available vs captured).
- Tax analytics as in 2.11, including "days to long-term" countdowns, early-exit tax premiums, and harvest candidates; optional after-tax P&L presentation (`subtractFromResults`).
- Execution-cost modeling debits simulated fills so paper edges are net of a realistic cost model.

### 3.11 Learning loop & tuning
- **Post-mortem reflection**: after runs, closed trades are reflected on (LLM) and distilled into an advisory reflection summary retrievable in chat.
- **Strategy tuning proposal** (`StrategyTuningProposal`): an LLM (or deterministic local rules when no LLM) reads the performance readout, market context, scorecards, and missed opportunities, and proposes a patch (`prompt`, `scoringWeights`, selected policy fields incl. `riskRules`/`sectorCaps`) with summary/rationale/cautions/confidence. Every weight delta is clamped to **±0.05 per factor per step** (`MAX_WEIGHT_STEP`); invariant validation rejects unsafe patches; an **out-of-sample walk-forward gate** (chronological split, embargo, optional purge) must validate weight moves — unvalidated moves are **withheld by default**.
- **Autonomous apply** (opt-in, layered gates): cadence-gated after successful runs; requires the OOS gate, optional minimum IC improvement + paired-t significance, optional drawdown guard and minimum distinct test dates; writes a prior-weights snapshot to the learning ledger for one-action revert; an optional **shadow ledger** records what *would* have been applied without touching policy (forward A/B trail before trusting autonomy).
- Congressional-signal governance: a statistical go/no-go evaluation can zero the congress term in scoring when unvalidated (opt-in gating).
- Admin **tuning dry-run** and **factor-IC backtest** endpoints exercise all of this without side effects.

### 3.12 Alert delivery
Two layers: (1) per-account **event notifications** (the `enabledEvents` types) delivered to a webhook (rich embeds for one popular chat service, generic JSON otherwise) and recorded in-app; (2) per-user **multi-channel notify** for triggered price alerts and server-originated notices — phone push (ntfy topic or Pushover key), HTTPS webhook, email, SMS — delivering to every enabled+configured channel, recording per-channel success/failure, never throwing. Plus real-time SSE to connected clients and mobile.

### 3.13 Admin & platform ops
Everything in 2.14, plus: usage-budget feedback (alerts when a provider exceeds its monthly budget; enforcement building blocks exist but are deliberately not wired into the money path; **fail-open** — a monitor outage never stops trading); a nightly provider-tier watchdog that detects a lapsed paid data plan and auto-clamps request rates; scheduler heartbeat for external supervision; health/readiness endpoints; append-only audit trail with account-scoped attribution; optional single-leader lease (`SCHEDULER_SINGLE_LEADER`) so multi-process deployments don't double-run; streaming ingestion (broker news/price/trade-update streams) feeding the evidence layer.

---

## 4. Hard safety invariants

1. **Halting never sells.** `halted` stops *all* order flow including protective exits; liquidation is a separate, explicit human choice (`liquidating`). No state transition ever auto-liquidates a portfolio. Conversely, `close_only`/`liquidating` must never disable protective exits — the stop monitor runs in those states by design.
2. **Exits are never trapped.** Universe removal, blocklisting, exposure caps, sector caps, daily caps, capability loss, and shorting-disablement can never block a risk-reducing sell/cover. A cap that demanded an exit can never block that exit.
3. **Word-first money-reality.** The execution mode is a derived, persisted, three-valued fact (`test/local` / `broker/paper` / `broker/live`) with explicit word labels (Test / Paper / Brokerage) and clarification sentences; every proposal, fill, and snapshot is stamped with it; approvals refuse to execute across a mode mismatch; and real-money approval requires typing words (`APPROVE LIVE <SYMBOL>`), not clicking. Real capital is reachable only through `broker/live` + policy gate + (in propose mode) typed human confirmation.
4. **Server-side validation is the boundary.** Nothing client-supplied is trusted: identity comes from a verified header, chat tool inputs are re-validated, mobile `policy.patch` has a strict field allowlist (account bindings, `paperMode`, and secrets are unpatchable), drafts promote only to buy/sell, and the full policy gate re-runs at execution time regardless of what any client claims was already checked.
5. **Fail closed on the money path.** Missing broker capabilities read as false; a required-but-unavailable Red Team review routes to a human instead of auto-executing; a missing LLM credential is a hard run failure (never a fabricated rule-based stand-in); enabled staleness gates treat a missing timestamp as stale; the learned-context risk classifier defaults unknown material to 'risk' (queued or dropped, never silently applied); boot reverts `active` to `halted`; unvalidated weight moves are withheld; a proposal that expired/withdrew mid-approval is not placed. Fail-*open* is reserved for purely advisory systems (budget monitor, evidence enrichment).
6. **Durable order intent + idempotency.** A `placing` row with an idempotency `refId` is persisted *before* every broker call; a lost response becomes a reconcilable record, never an invisible orphan; broker "200 but declined" states are detected and never recorded as placed; approvals and runs serialize on one lock and claim proposals with compare-and-swap.
7. **Numeric learning never bypasses humans or clamps.** Learned context reaches the brain only as advisory text; autonomous weight changes are clamped, statistically gated, ledgered, and revertible; presets never change arming state; approving a queued risk fact never auto-derives a numeric policy change.
8. **Provenance honesty.** Real data is never labeled mock; missing data is shown as absent, never invented (`n/a` vs `-` distinction, no fabricated earnings dates, no synthetic spreads treated as real); the provider chain per value is recorded and exposed.

---

## 5. Data freshness & provider constraints

- **Quotes are delayed by default.** The scan's base is a public delayed screener; broker quotes (when a broker is connected) refresh the top candidates. Scans are cached (~5 min TTL, configurable); `MarketScan.generatedAt` and per-symbol `asOf` are the truth an interface should surface, and the optional staleness gates consume them.
- **Yahoo Finance is the keyless floor**: every symbol gets real fundamentals/ratings data with zero configuration; Finnhub/FMP/Alpha Vantage/FRED/Massive/Voyage/Pinecone keys progressively unlock richer tiers (news sentiment, analyst detail, price targets, macro, breadth/news, filings RAG). The LLM loop requires an OpenAI-compatible key; without it everything except proposal generation still works.
- **Rate limits are first-class**: free-tier ceilings (e.g. 5 REST calls/min on one data provider, 3 embedding requests/min) are enforced with clamps and batching; a per-credential-lane circuit breaker stops hammering a failing provider after 5 consecutive failures; a tier watchdog detects paid-plan lapses and auto-clamps.
- **Cache scoping / consent**: env-keyed and free data is shared across users; user-keyed data stays private unless the user consents to the reciprocal pool; macro data fetched with a user key never leaks into the shared cache.
- **Market hours matter**: runs, re-validations, and synthetic stops respect a market calendar (holidays/weekends), regular vs extended hours, and per-policy extended-hours opt-ins; fractional/dollar orders are regular-hours only.
- **Web-source evidence is cadence-gated** (roughly daily; filings weekly) and timestamped; congressional/insider/short/technical signals carry their own freshness and are cached with explicit provenance.
- P&L marks, benchmark curves, and tax figures are computed from persisted fills/snapshots plus current prices; anything uncomputable renders as absent rather than estimated.

---

## 6. Scale assumptions

- **Single-digit users.** Multi-user isolation is real (per-user ids, data partitioning, per-user keys/consent/usage metering), but the population is the owner plus a handful of invited tenants; admin is an email allowlist, and the primary operator's account doubles as the legacy single-user dataset.
- **One SQLite file, one process.** All state lives in a single local SQLite database (~40 tables, WAL, streaming replication available for backup). The scheduler, SSE event bus, trigger engine, and mobile-command worker are in-process singletons; cross-process coordination exists only as an optional leader lease. There is no external queue, cache server, or database service.
- **Bounded everything**: max 3 concurrent account runs, small mobile-command batches, capped enrichment candidates per scan, capped proposals per run, capped skipped-evidence persistence — the system is tuned for a few accounts trading a few names per hour, not for throughput.
- **Latency envelope**: a strategy run is seconds-to-a-minute (scan + LLM + gates); commands are queued and observable rather than instant; real-time-ness comes from 60-second ticks and SSE pushes, not streaming market data. An interface should treat "fresh within a minute" as the norm and surface timestamps rather than promising real time.
