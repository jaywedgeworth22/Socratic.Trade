# Phase 7 - AI Trading Strategy (Design)

This document defines the comprehensive architecture for the AI Trading Strategy, including how the LLM evaluates the market, scores individual equities, and continuously learns from its own outcomes.

## 1. Strategy Architecture: Evaluation Lenses

To ensure balanced and resilient trade proposals, the LLM evaluates candidates
across macro, fundamental, technical, sentiment/news, alternative-data, and
adversarial-debate lenses before making a decision.

### A. Macro, Thematic, & Market Context
*Don't fight the Fed, and don't fight the broader trend.*
- **Core Macro Indicators:** SPY/QQQ daily trends, `^VIX` (Volatility Index), Fed Funds Rate trajectory, CPI/Inflation trends, Unemployment data, and broad market breadth (advancers vs. decliners).
  - *Implementation Target:* Integrate `VIXCLS` via the FRED API (already available in `macro.ts`) to immediately unlock "de-risk in high-vol regimes" logic.
- **Thematic & Structural Shifts:** Tracking long-term disruptive trends that create secular tailwinds or headwinds across entire sectors (e.g., GLP-1 weight loss drug adoption impacting not just food/healthcare, but downstream retail, clothing, and cosmetics sectors; AI infrastructure spending; housing/cost of living trends; and shifting consumer habits).
- **Goal:** Establish the risk regime. In a high-VIX or downtrending market, the strategy should naturally demand higher conviction for long positions, pivot to defensive sectors, or seek opportunistic **short** setups.

### B. Fundamental Factors
*Ensure underlying business health and value.*
- **Indicators:** Forward P/E Ratio vs. Sector Average, EPS Growth (QoQ/YoY), Free Cash Flow yield, Debt-to-Equity ratio, and forward guidance sentiment.
  - *Implementation Target:* Leverage SEC EDGAR (free, authoritative) for XBRL financials and 8-K filings, and explore Twelve Data or Tiingo for enhanced fundamental indicators.
- **Goal:** Identify structurally sound companies that are mispriced relative to their earnings potential for long positions, or conversely, identify fundamentally deteriorating companies (e.g., shrinking margins, high debt) as prime **short** candidates.

### C. Technical Factors
*Optimize entry and exit timing.*
- **Indicators:** Moving Averages (50-day and 200-day alignment), RSI (detecting extreme overbought > 70 or oversold < 30 conditions), MACD crossovers, Support/Resistance zones, and anomalous Volume spikes.
- **Goal:** Prevent buying "value traps" that are in a freefall, avoid chasing fundamentally strong stocks that are dangerously overextended, and optimally time entries for **short** positions (e.g., shorting at strong resistance or breakdown confirmations).

### D. Sentiment & News Catalysts
*Identify short-term directional fuel.*
- **Indicators:** Real-time company-specific headlines, earnings call sentiment (derived from NLP), sector-level news, and macro shock events.
  - *Implementation Target:* Upgrade the current keyword-heuristic sentiment scorer to a real ML model. Prioritize **Alpha Vantage NEWS_SENTIMENT** (drop-in API, utilizing our existing key) or score existing Finnhub headlines via a local **FinBERT** model. Use zero-key RSS feeds (Yahoo Finance, Google News) for broad catalyst capture.
- **Goal:** Anticipate sudden price re-ratings driven by external events that technicals and fundamentals have not yet priced in.

### E. Alternative Data & Alpha
*Gain an informational edge over retail consensus.*
- **Indicators:** Insider trading ratios (Form 4), Congressional trading activity, Unusual Options Activity (UOA) / Dark Pool prints, and NLP summarization of raw SEC EDGAR filings (8-K Material Events, 10-Q Risk Factors).
  - *Implementation Target:* Prioritize **FMP's senate and insider endpoints** (since the FMP key is already integrated) as the most cost-effective path to smart-money signals. Add SEC EDGAR RSS for authoritative Form 4 insider trades.
  - *(Note: We will integrate the Quiver Quantitative API in the short-term future to specifically source high-quality Congressional trading and lobbying data).*
- **Legislative & Litigation Risk:** Actively monitoring for pending lawsuits, anti-trust actions, or major legislative changes (e.g., subsidies, new tariffs, regulatory approvals) that could drastically re-rate a company's valuation overnight.
- **Token Efficiency Mechanism:** Raw filings and options chains are *never* fed directly to the active prompt. An asynchronous background task digests these alternative data streams and produces 1-sentence bulletins (e.g., *"Insider buying detected at 52-week lows; 8-K shows new DoD contract"*).
- **Goal:** Uncover hidden risks or catalysts before they hit mainstream financial news headlines.

### F. Multi-Agent "Bull vs. Bear" Debate
*Prevent confirmation bias and hallucination.*
- **Mechanism:** Before a high-conviction trade is finalized, the proposal is routed to a separate "Red Team / Bear" prompt. This prompt is tasked *exclusively* with finding reasons the trade will fail (e.g., hidden technical resistance, negative sector news, overvaluation).
- **Goal:** The main agent must successfully address or invalidate the Bear agent's concerns before the trade is approved, ensuring maximum robustness and quality.

---

## 2. Initial Factor Weighting Matrix

When initially deployed (or for new Strategy Profiles), the system uses a default scoring matrix to blend the core deterministic factor scores. The LLM sees these scores plus source evidence and scales its confidence around them rather than replacing deterministic policy gates.

**Baseline Default Weights:**
- **Fundamentals (Value/Growth): 30%** (Anchor the portfolio in real business health)
- **Macro/Regime Alignment: 25%** (Respect the broader market environment)
- **Technicals (Timing/Momentum): 25%** (Ensure optimal entry execution)
- **News/Sentiment (Catalysts): 20%** (Capture short-term momentum triggers)

*Note: The strategy is designed to allow these weights to be dynamic. They serve as a starting point, but the system will actively recommend tuning them based on actual performance.*

---

## 3. The Auto-Tuning Engine (The Learning Loop)

The most critical component of the AI strategy is its ability to remember past trades, evaluate its own decisions, and suggest improvements. This forms the "Auto-Tuning Engine".

### A. Context Snapshots & Execution Metrics
Every executed trade records a comprehensive `StrategyOutcome` that goes far beyond simple P&L.
- **Execution Realism:** The learning loop explicitly penalizes the LLM for slippage and transaction costs. The system logs gross vs. net performance, forcing the LLM to learn the "cost of doing business" and favoring higher-conviction setups over rapid, unprofitable scalping.
- **Context Snapshots:** The system logs `entryMarketRegime` and `exitMarketRegime` (e.g., exact VIX and SPY trend at the time of the trade). This allows the LLM to learn context-specific rules (e.g., "My momentum trades fail when VIX > 25").
- **MAE & MFE:** The system calculates Maximum Adverse Excursion (MAE) and Maximum Favorable Excursion (MFE) during the holding period. This teaches the LLM about its timing: Is it cutting winners too early? Is it holding losers too long through massive drawdowns?
- **Trade Thesis Classification:** The LLM must tag its initial proposal with a `tradeThesisTag` (e.g., *Mean Reversion*, *Breakout*, *Value Play*, *Earnings Catalyst*). 

```ts
export interface StrategyOutcome {
  proposalId?: string;
  runId?: string;
  accountNumber: string;
  source: "paper" | "live";
  symbol: string;
  side: "buy" | "sell" | "short" | "cover";
  rationale: string;
  entryPrice?: number;
  entryAt?: string;
  exitPrice?: number;
  exitAt?: string;
  currentPrice?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  returnPct?: number;
  holdingDays?: number;
  sector?: string;
  tradeThesisTag?: string; // e.g., Mean Reversion, Breakout, Value
  riskExit?: "stop_loss" | "take_profit" | "trailing_stop";
  entryMarketRegime?: any; // Snapshot of SPY, QQQ, VIX at entry
  exitMarketRegime?: any; // Snapshot of SPY, QQQ, VIX at exit
  mae?: number; // Maximum Adverse Excursion during holding
  mfe?: number; // Maximum Favorable Excursion during holding
}
```

### C. Risk Management & Short Selling Guardrails
While the strategy evaluates trades across the strategy lenses, it must also respect absolute risk parameters, especially given the infinite risk profile of short selling.
- **Short Selling Risk Cap:** Short positions must be heavily scrutinized. The maximum allowable portfolio allocation for any single short position will be strictly capped (e.g., lower than long positions).
- **Hard Stop-Losses:** Any short proposal must carry an absolute, non-negotiable stop-loss logic (e.g., max 5% adverse excursion) to prevent runaway losses.

### C.1 Pending-Proposal Staleness (Expiry + On-Run Re-Validation)
Proposals stay in the approval queue until a human approves or rejects them, so an old one can keep looking like a current recommendation. Two mechanisms keep the queue honest (`src/lib/proposal-revalidation.ts`):

1. **Deterministic hard expiry** — `policy.proposalExpiryMinutes` (default 2880 = 2 days; 0 = Never). A pending proposal older than the TTL is moved to status `expired` with an audit event, a `proposal_withdrawn` notification, and an SSE refresh. It runs at the **start of every strategy run** and on **every scheduler tick** (even while halted or the market is closed), so the queue self-clears regardless of run cadence. UI: a dropdown (3h / 6h / 12h / 1d / 2d / 5d / 10d / Never).
2. **On-run LLM re-validation, cadence-gated to market hours** — `policy.revalidatePendingOnRun` (default on) with `policy.proposalRevalidateCadenceHours` (default 3). Inside `runStrategyOnce`, each still-pending proposal that is **due** (≥ cadence hours since it was created or last re-checked) is re-checked against the fresh scan + current regime in one batched LLM call ("does this still stand?"). It runs **only during the regular US session** (`currentMarketSession === "regular"`), so each proposal is re-validated a few times across a trading day and never overnight — re-checking when nothing can be acted on is wasted work and the scan would be stale. `reaffirm` stamps `last_revalidated_at` (the dashboard then shows "Re-checked X ago — still advised" and the staleness clock resets); `withdraw` moves it to status `withdrawn`. Ambiguous/missing output defaults to *keep*; the pass is skipped (deterministic expiry still applies) when the market is closed, `OPENAI_API_KEY` is absent, or the call fails. UI: a dropdown (Off / every 1h / 2h / 3h / 4h / 6h).

### D. Token Efficiency & Asynchronous Post-Mortems
Feeding dozens of raw rationales, P&L lines, and redundant daily news into the trading prompt wastes massive amounts of tokens and degrades LLM reasoning. To optimize this:

1. **Information-Theoretic Pruning (Tiered Memory):** The system feeds the LLM only *delta* (change) information. If the Fed Funds rate or broader macro context hasn't changed since yesterday, it is excluded. Short-term memory (daily headlines) decays quickly, while long-term memory (quarterly reports) is compressed.
2. **Asynchronous Reflection:** A background task (e.g., nightly or weekly) analyzes recently closed trades against their original `tradeThesisTag` and `entryMarketRegime`.
3. **Prompt Auto-Pruning (OPRO):** During this reflection, the LLM generates a highly condensed **Reflection Summary** (e.g., *"Lesson: Tech breakouts failing due to choppy VIX"*). Furthermore, it actively rewrites and prunes its own prompt instructions, dropping rules that are no longer relevant to the current market regime to save tokens.
4. **Injection:** Only this concise "Lessons Learned" block and the auto-pruned instructions are injected into the active trading prompt, providing high-signal feedback at a fraction of the token cost.

**Implemented (2026-06-16):**
- **Outcome-aware Thesis Scorecard** — `getThesisScorecard()` (`performance.ts`)
  computes realized win rate / avg return / total P&L per `tradeThesisTag` from
  closed lots (deterministic, zero tokens) and injects it as
  `tradeOutcomesByThesis` into both the Bull prompt (with an instruction to
  favor proven theses and avoid repeat losers) and the post-mortem reflection,
  so the reflection is grounded in what actually made/lost money rather than
  trade descriptions alone.
- **Gated reflection** — `generateReflectionSummary` only regenerates when the
  trade history changed (signature = `#filledTrades:latestFillTime`), instead of
  every run. This saves an LLM call on no-fill runs and keeps the Bull
  system-prompt prefix stable so provider prompt-caching can hit.
- **Bounded LLM requests (2026-06-20)** — Bull, Bear, Red Team, strategy-tuning,
  and post-mortem calls now use shared OpenAI request bounds with deterministic
  temperature and explicit output caps. Their prompts and payloads also use
  `test/local`, `broker/paper`, and `broker/live` wording so broker-hosted paper
  fills are not confused with local simulated fills.
- **Context trimming** — large allowlists (e.g. full S&P 500) are sent as a
  compact note instead of every ticker; `recentOrders` is slimmed to 8 records;
  the Bear/critique agent receives only the candidates under review rather than
  a second full copy of the market scan.
- **Regime-conditioned outcomes** — `getRegimeScorecard()` groups realized
  outcomes by `entryMarketRegime`; `tradeOutcomesByRegime` is fed to the Bull
  (compare today's regime to history), Bear, and reflection.
- **MAE/MFE excursion lessons** — `getExcursionsByThesis()` (replacing the old
  `runPostMortems` stub) aggregates holding-period adverse/favorable excursions
  and capture-of-favorable-move per thesis, computed only in the gated async
  post-mortem so the proposal path stays network-free.
- **Delta-only macro pruning** — `pruneMacro()` sends only changed (plus
  regime-critical) macro fields on repeat runs, listing the rest as unchanged.
- Still TODO from this section: OPRO-style prompt self-rewrite (intentionally
  kept advisory-only via Strategy Studio's human-approved tuning, not
  auto-applied) and persisted MAE/MFE per closed lot (currently recomputed each
  gated reflection).

**Implemented (2026-06-16, signals + learning pass — branch `ui-redesign`):**
This pass implemented the tractable subset of Codex's "Stronger Trading Signals
And Learning Loop" research plan, honoring its directive to *finish plumbing
existing fields end-to-end before adding new providers*.
- **Pillar-B/E fields plumbed end-to-end.** `fcfYield`, `debtToEquity`, and
  `epsGrowth` (Pillar B, section 1.B) now feed `valueScore`/`qualityScore`
  (`market.ts`); `insiderSentiment` and `senateTrades` (Pillar E, section 1.E)
  plus the three fundamentals are now emitted per candidate by
  `compactMarketScanForPrompt` and shown in the Market Scan table (FCF% / D/E /
  EPS gr columns). These fields were already fetched through the enrichment
  cascade but dead-ended before reaching scoring/prompt/UI.
- **Fixed thesis playbook** (replaces the free-form `tradeThesisTag`).
  `THESIS_PLAYBOOK` (10 tags) now constrains both the Bull and Bear JSON schemas
  (`enum`), so the thesis x outcome scorecards bucket consistently and can
  accumulate learnable samples. The proactive risk-exit tag is now `"Risk-Exit"`.
- **Bayesian shrinkage on the scorecards** (section 3.E small-sample guardrail).
  `aggregateClosedLots` adds `shrunkWinRate`/`shrunkAvgReturnPct` (neutral
  50%/0% prior, 5-trade pseudo-count); the Bull prompt instructs the agent to
  prefer the shrunk rates when `trades` is small. This is a prerequisite for the
  section 3.E "minimum 20 outcomes" gate to behave sanely on partial samples.
- **Counterfactual candidate log** (raw material for section 3 learning).
  `runStrategyOnce` writes a `candidates_considered` audit event per run: what
  the agent chose (symbol/side/status/thesisTag) vs the top-8 skipped scan
  candidates by score, without fabricating fills for un-traded names.
**Implemented (2026-06-16, web-sources pass — branch `web-sources`, see
`docs/phase-9-web-sources.md`):**
- **EvidenceDigest / SignalSnapshot** (section 1.E "Token Efficiency Mechanism").
  Backend connectors digest congressional disclosures (Senate eFD + Capitol
  Trades) and SEC EDGAR Form 4 insider trades into 1-line `smartMoneyEvidence`
  bulletins fed to the prompt — raw rows stay out. `runStrategyOnce` also writes a
  `signal_snapshot` audit per run (per-symbol factor sub-scores + congress/insider
  net + bulletins + thesis × regime) so outcomes can later be correlated with the
  signals that preceded them.
- **Multi-dimensional learning** (section 3): `getThesisRegimeScorecard()` crosses
  thesis × regime (shrunk like the 1-D cards) and feeds `tradeOutcomesByThesisRegime`
  to the agent. Phase 10 later added sector-on-fills and `getSectorScorecard()`;
  the fully composite thesis × regime × sector × factor view is still a follow-up.
- **20-outcome guardrail** (section 3.E): `MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT = 20`
  now gates the auto-tuner — factor-weight changes are withheld (local-rules path
  emits no weight patch; LLM path is instructed to null all weights) until ≥20 lots
  have closed.
- **New providers**: congressional (Senate eFD / Capitol Trades) and SEC EDGAR
  Form 4 insider are live as backend web-sources (the user's FMP key is
  rate-limited, so those FMP senate/insider paths returned nothing).
- Later Phase 10 work added SEC 8-K bulletins, FINRA short-volume, market breadth,
  technical signals, Fama-French factors, Cboe SKEW/VVIX, CFTC COT, and sector
  learning. Still deferred: House congressional coverage when a stable free feed is
  available, weight shifts wired into *sizing* (currently advisory via Strategy
  Studio), richer per-filing document digests, and factor-bucket learning.

### E. Human-Approved Weight Shifting
The ultimate expression of the learning loop is adjusting the Initial Factor Weighting Matrix and Sector Allocations.

- The system generates advisory suggestions that analyze outcome performance across factor scores, `tradeThesisTag`, market regime, and industry sectors.
- **Dynamic Factor Weight Shifting:** If the Post-Mortem reveals that trades heavily weighted by "Fundamentals" are losing money in a speculative market, but "Technicals" are winning, the system will suggest a policy patch: *"Decrease Fundamental Weight by 5%, Increase Technical Weight by 5%."*
- **Dynamic Sector Allocation Shifting:** The system continuously evaluates portfolio performance by industry sector. It will suggest *mild to moderate* target allocation shifts over time (e.g., reducing Technology exposure from 30% to 20% if the sector begins underperforming). It is explicitly designed to avoid extreme concentration (e.g., it will never suddenly recommend shifting the portfolio to 99% in one stock or sector).
- **Guardrails:** 
  - Minimum 20 outcomes before suggesting factor shifts.
  - Maximum 5-point weight delta per factor suggestion.
  - Maximum 10-point weight delta per sector shift suggestion.
  - Strict sector concentration caps (e.g., no single sector can exceed 40% of the portfolio).
  - Never auto-apply; requires human approval via the Dashboard.

## 4. Test Plan
- **Context/Outcome Fixture:** Seed buy/sell fills and assert that `entryMarketRegime`, `mae`, and `mfe` are accurately captured and calculated.
- **Post-Mortem Generation:** Test the async reflection LLM prompt to ensure it synthesizes raw outcomes into a concise paragraph.
- **Weight Shifting Logic:** Create a mock history of failing "Value" trades and assert that the system successfully suggests a negative delta to the Fundamentals weight.

## 5. Sequencing
1. Implement the expanded `StrategyOutcome` schema and the 4-Pillar data fetching (Macro, Fundamentals, Technicals, News).
2. Implement the Asynchronous Post-Mortem task to generate the `reflection_summary`.
3. Feed the reflection summary into the main `runStrategyOnce` prompt.
4. Implement the human-approved Weight Shifting suggestions in the Dashboard.
