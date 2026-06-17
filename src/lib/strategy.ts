import {
  acquireStrategyLock,
  audit,
  dailyExecutionStats,
  finishStrategyRun,
  getPolicy,
  getProposal,
  getStrategyPrompt,
  insertProposal,
  insertStrategyRun,
  listFillEvents,
  releaseStrategyLock,
  updateProposalStatus,
  updateFillEvent
} from "./db";
import { mergeQuoteData, scanMarket } from "./market";
import { fetchMacroData, pruneMacro, type MacroData } from "./macro";
import { normalizeSymbol } from "./money";
import { sendNotification } from "./notifications";
import { getPaperPortfolioProjection, getRegimeScorecard, getThesisRegimeScorecard, getThesisScorecard, recordFillFromProposal, recordPortfolioSnapshot } from "./performance";
import { allowedSymbolsForPolicy, evaluateTradeProposal } from "./policy";
import { getTaxSummary, getWashSaleLockedSymbols } from "./tax";
import { getRobinhoodGateway, type RobinhoodGateway } from "./robinhood";
import { generateReflectionSummary } from "./post-mortem";
import { getSetting, getInternalSetting, setInternalSetting } from "./db";
import { debateProposal } from "./red-team";
import type { EquityOrder, EquityPosition, MarketScan, Portfolio, TradingPolicy, TradeProposal } from "./types";

export interface StrategyResult {
  runId: string;
  status: "completed" | "failed";
  summary: string;
  proposals: Array<{ proposal: TradeProposal; status: string; reasons: string[]; orderId?: string }>;
  marketScan?: MarketScan;
}

export async function runStrategyOnce(): Promise<StrategyResult> {
  // Run lock: prevent overlapping runs from double-counting daily limits.
  if (!acquireStrategyLock()) {
    return { runId: "", status: "failed", summary: "A strategy run is already in progress.", proposals: [] };
  }

  const runId = crypto.randomUUID();
  insertStrategyRun(runId);
  let result: StrategyResult;

  try {
    const policy = getPolicy();
    if (!policy.accountNumber) throw new Error("No account selected.");
    if (policy.killSwitch) throw new Error("Kill switch is active.");

    const gateway = getRobinhoodGateway();
    await reconcilePendingFills(gateway, policy.accountNumber);
    const [accounts, portfolio, positions, orders] = await Promise.all([
      gateway.getAccounts(),
      gateway.getPortfolio(policy.accountNumber),
      gateway.getEquityPositions(policy.accountNumber),
      gateway.getEquityOrders(policy.accountNumber)
    ]);
    const selected = accounts.find((account) => account.accountNumber === policy.accountNumber);
    if (!selected) throw new Error("Selected account is not available.");
    if (!selected.agenticAllowed) throw new Error("Selected account is not agentic_allowed.");

    const allowedSymbols = allowedSymbolsForPolicy(policy);
    const baseMarketScan = await scanMarket(allowedSymbols, positions, policy.scoringWeights);
    const quoteSymbols = uniqueSymbols(baseMarketScan.topCandidates.map((quote) => quote.symbol));
    const marketScan = mergeQuoteData(baseMarketScan, await gateway.getEquityQuotes(policy.accountNumber, quoteSymbols));
    const daily = dailyExecutionStats(policy.accountNumber);
    const washSaleLockedSymbols = getWashSaleLockedSymbols(policy.accountNumber, policy.paperMode ? "paper" : "live");

    // In Paper mode, decisions run against the standalone paper account (starting cash +
    // prior paper fills, marked to live prices) so the simulation evolves like Live.
    const currentPrices = currentPricesFromScan(marketScan);
    const account = policy.paperMode
      ? getPaperPortfolioProjection({ accountNumber: policy.accountNumber, startingCash: policy.paperStartingCash, currentPrices })
      : { portfolio, positions };
    const workingPortfolio = account.portfolio;
    const workingPositions = account.positions;

    const proactiveProposals = generateProactiveRiskProposals(workingPositions, currentPrices, policy);

    const llmProposals = await proposeTrades({
      policyAllowlist: allowedSymbols,
      prompt: getStrategyPrompt(),
      policy,
      portfolio: workingPortfolio,
      positions: workingPositions,
      recentOrders: compactRecentOrders(orders),
      marketScan,
      dailyNotionalUsed: daily.notional,
      dailyOrderCount: daily.orderCount
    });

    const debatedProposals: TradeProposal[] = [];
    for (const proposal of llmProposals) {
      if ((proposal.confidenceScore ?? 0) >= 80) { // High conviction threshold
        const isBullish = proposal.side === "buy" || proposal.side === "cover";
        const quote = marketScan.topCandidates.find(c => normalizeSymbol(c.symbol) === normalizeSymbol(proposal.symbol));
        const redTeamResult = await debateProposal(proposal, quote, isBullish);
        if (redTeamResult.rejected) {
          console.log(`[Debate] Rejected ${proposal.symbol} ${proposal.side}: ${redTeamResult.reason}`);
          // Skip this proposal completely, as the Red Team found a critical flaw
          continue;
        } else {
          proposal.rationale += `\n\nRed Team Debate Survived: ${redTeamResult.reason}`;
        }
      }
      debatedProposals.push(proposal);
    }

    const proposals = [
      ...proactiveProposals,
      ...debatedProposals
    ];

    const results: StrategyResult["proposals"] = [];
    for (const proposal of proposals) {
      const normalizedProposal = { ...proposal, symbol: normalizeSymbol(proposal.symbol) };
      const tradability = await gateway.getEquityTradability(policy.accountNumber, [normalizedProposal.symbol]);
      if (!tradability[normalizedProposal.symbol]?.tradable) {
        const decision = { approved: false, reasons: [tradability[normalizedProposal.symbol]?.reason ?? "Symbol is not tradable."] };
        const proposalId = crypto.randomUUID();
        insertProposal({ id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, status: "blocked" });
        await sendNotification(
          {
            type: "block",
            title: `${normalizedProposal.side.charAt(0).toUpperCase() + normalizedProposal.side.slice(1)} ${normalizedProposal.symbol} blocked`,
            payload: { runId, proposalId, decision, proposal: normalizedProposal }
          },
          { policy }
        );
        results.push({ proposal: normalizedProposal, status: "blocked", reasons: decision.reasons });
        continue;
      }

      const review = await gateway.reviewEquityOrder({ accountNumber: policy.accountNumber, ...normalizedProposal });
      const dailyNow = dailyExecutionStats(policy.accountNumber);
      const decision = evaluateTradeProposal(normalizedProposal, {
        policy,
        portfolio: workingPortfolio,
        positions: workingPositions,
        dailyNotionalUsed: dailyNow.notional,
        dailyOrderCount: dailyNow.orderCount,
        estimatedNotional: review.estimatedNotional,
        marketScan,
        washSaleLockedSymbols
      });

      if (!decision.approved) {
        const proposalId = crypto.randomUUID();
        insertProposal({ id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, review, estimatedNotional: review.estimatedNotional, status: "blocked" });
        await sendNotification(
          {
            type: "block",
            title: `${normalizedProposal.side.charAt(0).toUpperCase() + normalizedProposal.side.slice(1)} ${normalizedProposal.symbol} blocked`,
            payload: { runId, proposalId, decision, review, proposal: normalizedProposal }
          },
          { policy }
        );
        results.push({ proposal: normalizedProposal, status: "blocked", reasons: decision.reasons });
        continue;
      }

      if (policy.strategyAuthority === "propose") {
        const proposalId = crypto.randomUUID();
        insertProposal({ id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, review, estimatedNotional: review.estimatedNotional, status: "proposed" });
        await sendNotification(
          { type: "pending_approval", title: `${normalizedProposal.symbol} awaiting approval`, payload: { runId, proposalId, proposal: normalizedProposal, review } },
          { policy }
        );
        results.push({ proposal: normalizedProposal, status: "proposed", reasons: [] });
        continue;
      }

      if (policy.paperMode) {
        const proposalId = crypto.randomUUID();
        insertProposal({ id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, review, estimatedNotional: review.estimatedNotional, status: "paper" });
        const fill = recordFillFromProposal({
          accountNumber: policy.accountNumber,
          proposalId,
          runId,
          source: "paper",
          proposal: normalizedProposal,
          review,
          marketScan,
          status: "filled"
        });
        await sendNotification(
          {
            type: "fill",
            title: `${normalizedProposal.symbol} Paper ${normalizedProposal.side.charAt(0).toUpperCase() + normalizedProposal.side.slice(1)}`,
            payload: { runId, proposalId, fill }
          },
          { policy }
        );
        results.push({ proposal: normalizedProposal, status: "paper", reasons: [] });
        continue;
      }

      const refId = crypto.randomUUID();
      const execution = await gateway.placeEquityOrder({ accountNumber: policy.accountNumber, ...normalizedProposal, refId });
      const proposalId = crypto.randomUUID();
      insertProposal({
        id: proposalId,
        runId,
        accountNumber: policy.accountNumber,
        proposal: normalizedProposal,
        decision,
        review,
        estimatedNotional: review.estimatedNotional,
        refId,
        orderId: execution.orderId,
        status: "placed"
      });
      const fill = recordFillFromProposal({
        accountNumber: policy.accountNumber,
        proposalId,
        runId,
        source: "live",
        proposal: normalizedProposal,
        review,
        execution,
        marketScan,
        status: execution.state === "filled" ? "filled" : "pending_reconciliation"
      });
      await sendNotification(
        { type: "fill", title: `${normalizedProposal.symbol} live order ${execution.state}`, payload: { runId, proposalId, fill } },
        { policy }
      );
      results.push({ proposal: normalizedProposal, status: "placed", reasons: [], orderId: execution.orderId });
    }

    // Counterfactual log: record the top-ranked scan candidates the agent did NOT
    // act on this run, so post-mortems can compare "what we bought" vs "what we
    // skipped" without pretending the skipped names had real fills.
    const chosenSymbols = new Set(results.map((r) => normalizeSymbol(r.proposal.symbol)));
    const skippedCandidates = (marketScan?.topCandidates ?? [])
      .filter((candidate) => !chosenSymbols.has(normalizeSymbol(candidate.symbol)))
      .slice(0, 8)
      .map((candidate) => ({
        symbol: candidate.symbol,
        score: candidate.score,
        sector: candidate.sector,
        intradayChangePct: candidate.intradayChangePct
      }));
    audit("candidates_considered", {
      runId,
      chosen: results.map((r) => ({ symbol: r.proposal.symbol, side: r.proposal.side, status: r.status, thesisTag: r.proposal.tradeThesisTag })),
      topSkipped: skippedCandidates
    });

    // SignalSnapshot / EvidenceDigest: persist the deterministic per-symbol evidence
    // that informed each chosen proposal (factor sub-scores, congressional/insider net
    // signals, 1-line bulletins, thesis × regime), so future learning can correlate the
    // signals that preceded a trade with its realized outcome. Raw rows stay out — only
    // this compact digest is stored.
    const quoteBySymbol = new Map((marketScan?.topCandidates ?? []).map((q) => [normalizeSymbol(q.symbol), q]));
    audit("signal_snapshot", {
      runId,
      asOf: new Date().toISOString(),
      signals: results.map((r) => {
        const q = quoteBySymbol.get(normalizeSymbol(r.proposal.symbol));
        return {
          symbol: r.proposal.symbol,
          side: r.proposal.side,
          status: r.status,
          thesisTag: r.proposal.tradeThesisTag,
          entryRegime: r.proposal.entryMarketRegime,
          score: q?.score,
          factorBreakdown: q?.factorBreakdown,
          congressNet: q?.senateTrades,
          insiderSentiment: q?.insiderSentiment,
          bulletins: q?.evidenceBulletins?.slice(0, 3)
        };
      })
    });

    const placed = results.filter((r) => r.status === "placed").length;
    const paperCount = results.filter((r) => r.status === "paper").length;
    const proposed = results.filter((r) => r.status === "proposed").length;
    const summary = [
      `Evaluated ${results.length} proposal(s).`,
      placed > 0 ? `Placed: ${placed}.` : "",
      paperCount > 0 ? `Paper: ${paperCount}.` : "",
      proposed > 0 ? `Awaiting approval: ${proposed}.` : ""
    ]
      .filter(Boolean)
      .join(" ");

    finishStrategyRun(runId, "completed", summary);
    // Always snapshot the real account; snapshot the paper account too when in Paper mode.
    recordPortfolioSnapshot({ runId, accountNumber: policy.accountNumber, source: "live", portfolio, positions });
    if (policy.paperMode) {
      const paperProjection = getPaperPortfolioProjection({
        accountNumber: policy.accountNumber,
        startingCash: policy.paperStartingCash,
        currentPrices
      });
      recordPortfolioSnapshot({
        runId,
        accountNumber: policy.accountNumber,
        source: "paper",
        portfolio: paperProjection.portfolio,
        positions: paperProjection.positions
      });
    }
    result = { runId, status: "completed", summary, proposals: results, marketScan };
    
    // Phase 7: Async trigger post-mortem reflection
    generateReflectionSummary(policy.accountNumber).catch((e) => console.error("Post-mortem error:", e));
    
  } catch (error) {
    const summary = error instanceof Error ? error.message : "Strategy failed.";
    finishStrategyRun(runId, "failed", summary);
    result = { runId, status: "failed", summary, proposals: [] };
    const policy = getPolicy();
    if (summary === "Kill switch is active.") {
      await sendNotification({ type: "kill_switch", title: "Kill switch blocked strategy run", payload: { runId, summary } }, { policy });
    } else {
      await sendNotification({ type: "run_failed", title: "Strategy run failed", payload: { runId, summary } }, { policy });
    }
  } finally {
    releaseStrategyLock();
  }

  // Audit is written here (inside the domain fn) so the scheduler path records it too.
  audit("strategy_run", result);
  return result;
}

export async function executeProposal(proposalId: string): Promise<{
  status: string;
  orderId?: string;
  reasons?: string[];
}> {
  const policy = getPolicy();
  if (!policy.accountNumber) throw new Error("No account selected.");
  if (policy.killSwitch) throw new Error("Kill switch is active.");

  const row = getProposal(proposalId);
  if (!row) throw new Error("Proposal not found.");
  if (row.status !== "proposed") throw new Error(`Proposal is already ${row.status}.`);

  const proposal = row.proposal;
  const gateway = getRobinhoodGateway();

  const [portfolio, positions] = await Promise.all([
    gateway.getPortfolio(policy.accountNumber),
    gateway.getEquityPositions(policy.accountNumber)
  ]);
  const allowedSymbols = allowedSymbolsForPolicy(policy);
  const approvalScanBase = await scanMarket(allowedSymbols, positions, policy.scoringWeights);
  const approvalQuoteSymbols = uniqueSymbols([...approvalScanBase.topCandidates.map((quote) => quote.symbol), proposal.symbol]);
  const approvalScan = mergeQuoteData(
    approvalScanBase,
    await gateway.getEquityQuotes(policy.accountNumber, approvalQuoteSymbols)
  );

  // In Paper mode, evaluate the approval against the standalone paper account.
  const currentPrices = currentPricesFromScan(approvalScan);
  const account = policy.paperMode
    ? getPaperPortfolioProjection({ accountNumber: policy.accountNumber, startingCash: policy.paperStartingCash, currentPrices })
    : { portfolio, positions };

  const tradability = await gateway.getEquityTradability(policy.accountNumber, [proposal.symbol]);
  if (!tradability[proposal.symbol]?.tradable) {
    const reason = tradability[proposal.symbol]?.reason ?? "Symbol is not tradable.";
    updateProposalStatus(proposalId, "blocked");
    audit("proposal_approved", { proposalId, symbol: proposal.symbol, side: proposal.side, action: "approval", result: "blocked", reason });
    await sendNotification(
      {
        type: "block",
        title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} blocked`,
        payload: { proposalId, reason, proposal }
      },
      { policy }
    );
    return { status: "blocked", reasons: [reason] };
  }

  const review = await gateway.reviewEquityOrder({ accountNumber: policy.accountNumber, ...proposal });
  const daily = dailyExecutionStats(policy.accountNumber);
  const decision = evaluateTradeProposal(proposal, {
    policy,
    portfolio: account.portfolio,
    positions: account.positions,
    dailyNotionalUsed: daily.notional,
    dailyOrderCount: daily.orderCount,
    estimatedNotional: review.estimatedNotional,
    marketScan: approvalScan,
    washSaleLockedSymbols: getWashSaleLockedSymbols(policy.accountNumber, policy.paperMode ? "paper" : "live")
  });

  if (!decision.approved) {
    updateProposalStatus(proposalId, "blocked", undefined, review, review.estimatedNotional);
    audit("proposal_approved", {
      proposalId,
      symbol: proposal.symbol,
      side: proposal.side,
      action: "approval",
      result: "blocked",
      reasons: decision.reasons
    });
    await sendNotification(
      {
        type: "block",
        title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} blocked`,
        payload: { proposalId, decision, review, proposal }
      },
      { policy }
    );
    return { status: "blocked", reasons: decision.reasons };
  }

  if (policy.paperMode) {
    updateProposalStatus(proposalId, "paper", undefined, review, review.estimatedNotional);
    const fill = recordFillFromProposal({
      accountNumber: row.accountNumber,
      proposalId,
      runId: row.runId,
      source: "paper",
      proposal,
      review,
      marketScan: approvalScan,
      status: "filled"
    });
    const paperProjection = getPaperPortfolioProjection({
      accountNumber: row.accountNumber,
      startingCash: policy.paperStartingCash,
      currentPrices: { ...currentPrices, ...(fill.price > 0 ? { [fill.symbol]: fill.price } : {}) }
    });
    recordPortfolioSnapshot({
      runId: row.runId,
      accountNumber: row.accountNumber,
      source: "paper",
      portfolio: paperProjection.portfolio,
      positions: paperProjection.positions
    });
    audit("proposal_approved", { proposalId, symbol: proposal.symbol, side: proposal.side, action: "approval", result: "paper" });
    await sendNotification(
      {
        type: "fill",
        title: `${proposal.symbol} Paper ${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)}`,
        payload: { proposalId, fill }
      },
      { policy }
    );
    return { status: "paper" };
  }

  const refId = crypto.randomUUID();
  const execution = await gateway.placeEquityOrder({ accountNumber: policy.accountNumber, ...proposal, refId });
  updateProposalStatus(proposalId, "placed", execution.orderId, review, review.estimatedNotional);
  const fill = recordFillFromProposal({
    accountNumber: row.accountNumber,
    proposalId,
    runId: row.runId,
    source: "live",
    proposal,
    review,
    execution,
    marketScan: approvalScan,
    status: execution.state === "filled" ? "filled" : "pending_reconciliation"
  });
  audit("proposal_approved", {
    proposalId,
    symbol: proposal.symbol,
    side: proposal.side,
    action: "approval",
    result: "placed",
    orderId: execution.orderId
  });
  await sendNotification(
    {
      type: "fill",
      title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} ${execution.state}`,
      payload: { proposalId, fill }
    },
    { policy }
  );
  return { status: "placed", orderId: execution.orderId };
}

export function rejectProposal(proposalId: string): void {
  const proposal = getProposal(proposalId);
  updateProposalStatus(proposalId, "rejected");
  audit("proposal_rejected", {
    proposalId,
    symbol: proposal?.proposal.symbol,
    side: proposal?.proposal.side,
    action: "rejection"
  });
}

/**
 * Fixed thesis "playbook" the agent must choose from. A bounded vocabulary keeps
 * the thesis × outcome learning loop consistent (free-form tags fragment the
 * scorecards and never accumulate enough samples to learn from).
 */
export const THESIS_PLAYBOOK = [
  "Momentum-Breakout",
  "Mean-Reversion",
  "Value-Quality",
  "Earnings-Catalyst",
  "Analyst-Revision",
  "Insider-Accumulation",
  "Short-Squeeze-Risk",
  "Defensive-Rotation",
  "Sector-Relative-Strength",
  "Risk-Exit"
] as const;

const THESIS_PLAYBOOK_GUIDE =
  "You MUST set `tradeThesisTag` to exactly one of the playbook tags: " +
  THESIS_PLAYBOOK.join(", ") +
  ". Pick the one that best fits the dominant evidence (e.g. Value-Quality for cheap, low-leverage, FCF-positive names; Momentum-Breakout for strong intraday/volume; Insider-Accumulation when insider/senate signals lead; Risk-Exit for stop-loss/take-profit/de-risking sells).";

async function proposeTrades(input: {
  policyAllowlist: string[];
  prompt: string;
  policy: TradingPolicy;
  portfolio: Portfolio;
  positions: EquityPosition[];
  recentOrders: unknown[];
  marketScan?: MarketScan;
  dailyNotionalUsed: number;
  dailyOrderCount: number;
}): Promise<TradeProposal[]> {
  if (!process.env.OPENAI_API_KEY) return fallbackProposal(input);

  const maxProposals = input.policy.maxProposalsPerRun ?? 3;
  const remainingNotional = Math.max(0, input.policy.maxDailyNotional - input.dailyNotionalUsed);
  const remainingOrders = Math.max(0, input.policy.maxDailyOrders - input.dailyOrderCount);

  // Phase 2 fix: build a full symbol→sector map from ALL scan candidates (not just
  // topCandidates) so holdings outside the top-30 still attribute to a sector.
  // We use the position's sector field (populated from the gateway) first, then
  // fall back to the scan for symbols not in the position data.
  const scanSectorBySymbol = new Map<string, string>(Object.entries(input.marketScan?.sectorBySymbol ?? {}));

  const sectorMap: Record<string, number> = {};
  for (const position of input.positions) {
    const sector =
      (position as EquityPosition & { sector?: string }).sector ??
      scanSectorBySymbol.get(normalizeSymbol(position.symbol));
    if (sector) {
      sectorMap[sector] = (sectorMap[sector] ?? 0) + position.marketValue;
    }
  }
  const sectorComposition =
    Object.keys(sectorMap).length > 0
      ? Object.fromEntries(
          Object.entries(sectorMap).map(([sector, value]) => [
            sector,
            input.portfolio.totalMarketValue > 0
              ? Math.round((value / input.portfolio.totalMarketValue) * 100)
              : 0
          ])
        )
      : undefined;

  const reflection = getSetting("reflection_summary", "");
  const source = input.policy.paperMode ? "paper" : "live";
  const thesisScorecard = input.policy.accountNumber ? getThesisScorecard(input.policy.accountNumber, source) : [];
  const regimeScorecard = input.policy.accountNumber ? getRegimeScorecard(input.policy.accountNumber, source) : [];
  // Multi-dimensional learning: thesis × regime buckets with >=2 closed lots (thin
  // buckets are noise; shrunk rates temper the rest). Top movers by |total P&L|.
  const thesisRegimeScorecard = (input.policy.accountNumber ? getThesisRegimeScorecard(input.policy.accountNumber, source) : [])
    .filter((bucket) => bucket.trades >= 2)
    .sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl))
    .slice(0, 8);
  const taxSummary = input.policy.accountNumber
    ? getTaxSummary(input.policy.accountNumber, source, currentPricesFromScan(input.marketScan), input.policy.taxSettings)
    : null;
  const taxContext = taxSummary
    ? {
        taxYear: taxSummary.taxYear,
        shortTermRealizedYTD: taxSummary.shortTermRealized,
        longTermRealizedYTD: taxSummary.longTermRealized,
        estimatedTaxLiability: taxSummary.estimatedTaxLiability,
        washSaleLockedSymbols: taxSummary.lockedSymbols,
        positionsNearLongTerm: taxSummary.openLots
          .filter((lot) => !lot.isLongTerm && lot.daysToLongTerm <= 45)
          .map((lot) => ({ symbol: lot.symbol, daysToLongTerm: lot.daysToLongTerm })),
        harvestableLosses: taxSummary.harvestCandidates.slice(0, 6)
      }
    : null;
  const systemPrompt = [
    "You are an autonomous equity trading agent for a Robinhood brokerage account.",
    "",
    "Investment Strategy:",
    input.prompt,
    "",
    "Historical Reflection & Lessons Learned:",
    reflection || "No historical reflection available yet.",
    "",
    "Your realized track record (in the user message):",
    "- `tradeOutcomesByThesis`: win rate, average return, and total P&L grouped by `tradeThesisTag`. Use `shrunkWinRate`/`shrunkAvgReturnPct` (Bayesian-shrunk toward neutral) over the raw rates when `trades` is small — a thesis with 2 trades is weak evidence. Lean into thesis types with a positive shrunk track record; be skeptical of or downsize ones that have repeatedly lost. Reuse a proven `tradeThesisTag` when the setup matches.",
    "- `tradeOutcomesByRegime`: the same outcomes grouped by `entryMarketRegime`. Compare today's regime (infer it from macroeconomicData, especially VIX and rates) to your history: demand more conviction for thesis/regime combinations that have lost, and size up where this regime has rewarded you.",
    "- `tradeOutcomesByThesisRegime`: realized outcomes for specific thesis×regime COMBINATIONS (e.g. a thesis that wins in Tech-Bull but loses in High-Vol). When today's inferred regime matches a combination here, weight that conditional record heavily; prefer shrunk rates for thin buckets.",
    ...(taxContext
      ? [
          "",
          "Tax efficiency (US, in the user message as `taxContext`): you trade in a taxable account, so factor the after-tax cost of churn.",
          "- NEVER propose a BUY of any symbol in `washSaleLockedSymbols` — it was sold at a loss within 30 days and the policy will block it (wash sale).",
          "- For winners in `positionsNearLongTerm`, prefer holding past the 1-year mark (long-term rate is much lower than the short-term ordinary rate) unless the thesis has clearly broken.",
          "- When realized short-term gains are large, you may harvest names in `harvestableLosses` (sell to realize the loss, offsetting gains) — but do not rebuy them within 30 days."
        ]
      : []),
    "",
    `When to SELL/TRIM: any position exceeding ${input.policy.maxSymbolExposurePct}% of portfolio value;`,
    `positions down more than ${input.policy.riskRules.stopLossPct ?? 8}% without a clear catalyst;`,
    `positions up more than ${input.policy.riskRules.takeProfitPct ?? 20}% where trimming would improve risk/reward; rebalancing toward better-ranked scan opportunities.`,
    "",
    "Evidence per candidate (in marketScan.topCandidates): factorBreakdown sub-scores, fcfYieldPct, debtToEquity, epsGrowth, newsSentiment, insiderSentiment, senateTradesNet, smartMoneyEvidence, analyst rating, headlines. Justify each proposal from this structured evidence, not vibes.",
    "smartMoneyEvidence holds freshly-disclosed congressional (and insider) trade bulletins; senateTradesNet is the net count of distinct members buying minus selling. Politicians disclose on a delay and copycat retail flow tends to follow a disclosure — a cluster of recent congressional/insider BUYS is a positioning tailwind worth front-running (size up, tag Insider-Accumulation), and a cluster of SELLS is a caution flag. Treat it as one input among many, not a standalone trigger.",
    THESIS_PLAYBOOK_GUIDE,
    "",
    "Return strict JSON only. No markdown. No text outside the JSON object."
  ].join("\n");

  // Delta-only macro: macro moves slowly, so on repeat runs send just the changed
  // (plus regime-critical) fields and note the rest as unchanged to save tokens.
  const macro = await fetchMacroData();
  const previousMacro = getInternalSetting<MacroData>("last_macro_sent");
  const { macro: macroForPrompt, omitted: macroOmitted } = pruneMacro(macro, previousMacro);
  setInternalSetting("last_macro_sent", macro);
  const macroeconomicData =
    macroOmitted.length > 0
      ? { ...macroForPrompt, unchangedSinceLastRun: macroOmitted }
      : macroForPrompt;

  // For a large allowed universe (e.g. the full S&P 500) the explicit ticker list
  // is mostly redundant with the scored marketScan candidates and costs hundreds of
  // tokens, so send a compact note instead of every symbol.
  const ALLOWLIST_INLINE_LIMIT = 60;
  const allowedSymbolsForPrompt =
    input.policyAllowlist.length > ALLOWLIST_INLINE_LIMIT
      ? {
          note: `Large allowed universe (${input.policyAllowlist.length} symbols). Only propose BUYs for symbols present in marketScan.topCandidates; you may SELL/TRIM any current position.`,
          sample: input.policyAllowlist.slice(0, 20)
        }
      : input.policyAllowlist;

  const userContent = {
    currentDate: new Date().toISOString(),
    portfolio: input.portfolio,
    positions: input.positions,
    recentOrders: input.recentOrders,
    allowedSymbols: allowedSymbolsForPrompt,
    marketScan: compactMarketScanForPrompt(input.marketScan),
    limits: {
      maxOrderNotional: input.policy.maxOrderNotional,
      remainingDailyNotional: remainingNotional,
      remainingDailyOrders: remainingOrders
    },
    macroeconomicData,
    ...(sectorComposition ? { sectorComposition } : {}),
    ...(thesisScorecard.length > 0 ? { tradeOutcomesByThesis: thesisScorecard.slice(0, 12) } : {}),
    ...(regimeScorecard.length > 0 ? { tradeOutcomesByRegime: regimeScorecard.slice(0, 8) } : {}),
    ...(thesisRegimeScorecard.length > 0 ? { tradeOutcomesByThesisRegime: thesisRegimeScorecard } : {}),
    ...(taxContext ? { taxContext } : {})
  };

  const url = process.env.OPENAI_API_URL || "https://api.openai.com/v1/responses";
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const isChatCompletions = url.includes("/chat/completions");

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["proposals"],
    properties: {
      proposals: {
        type: "array",
        maxItems: maxProposals,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "symbol",
            "side",
            "type",
            "quantity",
            "dollarAmount",
            "limitPrice",
            "stopPrice",
            "timeInForce",
            "marketHours",
            "rationale",
            "tradeThesisTag",
            "entryMarketRegime",
            "confidenceScore"
          ],
          properties: {
            symbol: { type: "string" },
            // SHORT_SELLING: Change to ["buy", "sell", "short", "cover"] when
            // policy.shortSellingEnabled is implemented and broker supports it.
            side: { enum: ["buy", "sell"] },
            type: { enum: ["market", "limit", "stop_market", "stop_limit"] },
            quantity: { type: ["number", "null"] },
            dollarAmount: { type: ["number", "null"] },
            limitPrice: { type: ["number", "null"] },
            stopPrice: { type: ["number", "null"] },
            timeInForce: { enum: ["gfd", "gtc"] },
            marketHours: { enum: ["regular_hours", "extended_hours", "all_day_hours"] },
            rationale: { type: "string" },
            tradeThesisTag: { enum: THESIS_PLAYBOOK },
            entryMarketRegime: { type: "string" },
            confidenceScore: { type: "number", description: "Conviction score from 1 to 100" }
          }
        }
      }
    }
  };

  const body = isChatCompletions
    ? {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(userContent) }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "trade_proposals",
            strict: true,
            schema
          }
        }
      }
    : {
        model,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(userContent) }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "trade_proposals",
            schema
          }
        }
      };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI request failed with ${response.status}: ${detail.slice(0, 500)}`);
  }
  const payload = await response.json();
  const text = payload.choices?.[0]?.message?.content ??
               payload.output_text ??
               payload.output?.flatMap((item: any) => item.content ?? []).find((item: any) => item.text)?.text;

  if (!text) {
    throw new Error("Empty response returned from LLM API.");
  }
  
  const bullProposals = sanitizeProposals(JSON.parse(text).proposals ?? [], maxProposals);
  if (bullProposals.length === 0) return [];

  // Phase 7: Bear Agent (Red Team) Critique
  const bearSystemPrompt = [
    "You are the Bear Agent (Red Team Risk Manager) for an autonomous trading system.",
    "Your objective is to CRITIQUE the following proposed trades generated by the Bull Agent.",
    "Evaluate each trade against the macro environment, fundamentals (P/B, short float), technicals, insider sentiment, and overall sector concentration risk.",
    "If a trade is too risky, unjustified, or misaligned with current market regimes, REMOVE it from your output.",
    "If a trade is acceptable but needs a tighter stop loss, better limit price, or smaller size, MODIFY it.",
    `If you approve a trade, you MUST set 'tradeThesisTag' to exactly one playbook tag (${THESIS_PLAYBOOK.join(", ")}) and add a concise 'entryMarketRegime' (e.g., 'High-Inflation-Bear', 'Tech-Bull') to track the learning loop.`,
    "Return strict JSON matching the schema, containing ONLY the surviving, approved proposals.",
    "If none survive, return an empty array."
  ].join("\\n");

  const bearSchema = {
    type: "object",
    additionalProperties: false,
    required: ["proposals"],
    properties: {
      proposals: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "symbol",
            "side",
            "type",
            "quantity",
            "dollarAmount",
            "limitPrice",
            "stopPrice",
            "timeInForce",
            "marketHours",
            "rationale",
            "tradeThesisTag",
            "entryMarketRegime"
          ],
          properties: {
            symbol: { type: "string" },
            // SHORT_SELLING: Change to ["buy", "sell", "short", "cover"] when
            // policy.shortSellingEnabled is implemented and broker supports it.
            side: { enum: ["buy", "sell"] },
            type: { enum: ["market", "limit", "stop_market", "stop_limit"] },
            quantity: { type: ["number", "null"] },
            dollarAmount: { type: ["number", "null"] },
            limitPrice: { type: ["number", "null"] },
            stopPrice: { type: ["number", "null"] },
            timeInForce: { enum: ["gfd", "gtc"] },
            marketHours: { enum: ["regular_hours", "extended_hours", "all_day_hours"] },
            rationale: { type: "string" },
            tradeThesisTag: { enum: THESIS_PLAYBOOK },
            entryMarketRegime: { type: "string" }
          }
        }
      }
    }
  };

  // The Bear only critiques the Bull's proposals, so it needs the candidates under
  // review plus risk context — not a second copy of the full market scan / allowlist.
  const proposedSymbols = new Set(bullProposals.map((proposal) => normalizeSymbol(proposal.symbol)));
  const candidatesUnderReview = userContent.marketScan?.topCandidates?.filter((candidate) =>
    proposedSymbols.has(normalizeSymbol(candidate.symbol))
  );
  const bearUserContent = {
    currentDate: userContent.currentDate,
    macroeconomicData: userContent.macroeconomicData,
    limits: userContent.limits,
    portfolio: userContent.portfolio,
    positions: userContent.positions,
    ...(sectorComposition ? { sectorComposition } : {}),
    ...(thesisScorecard.length > 0 ? { tradeOutcomesByThesis: thesisScorecard.slice(0, 12) } : {}),
    ...(regimeScorecard.length > 0 ? { tradeOutcomesByRegime: regimeScorecard.slice(0, 8) } : {}),
    ...(thesisRegimeScorecard.length > 0 ? { tradeOutcomesByThesisRegime: thesisRegimeScorecard } : {}),
    candidatesUnderReview,
    bullAgentProposals: bullProposals
  };

  const bearBody = isChatCompletions
    ? {
        model,
        messages: [
          { role: "system", content: bearSystemPrompt },
          { role: "user", content: JSON.stringify(bearUserContent) }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "bear_proposals",
            strict: true,
            schema: bearSchema
          }
        }
      }
    : {
        model,
        input: [
          { role: "system", content: bearSystemPrompt },
          { role: "user", content: JSON.stringify(bearUserContent) }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "bear_proposals",
            schema: bearSchema
          }
        }
      };

  const bearResponse = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify(bearBody)
  });

  if (!bearResponse.ok) {
    console.warn("Bear Agent API failed, falling back to Bull proposals");
    return bullProposals;
  }
  
  const bearPayload = await bearResponse.json();
  const bearText = bearPayload.choices?.[0]?.message?.content ??
                   bearPayload.output_text ??
                   bearPayload.output?.flatMap((item: any) => item.content ?? []).find((item: any) => item.text)?.text;

  if (!bearText) {
    return bullProposals;
  }

  const parsedBear = JSON.parse(bearText).proposals ?? [];
  return sanitizeProposals(parsedBear, maxProposals);
}

function currentPricesFromScan(scan?: MarketScan): Record<string, number> {
  if (!scan) return {};
  return Object.fromEntries(
    Object.values(scan.quotesBySymbol)
      .filter((quote) => quote.price > 0)
      .map((quote) => [quote.symbol, quote.price] as const)
  );
}

function uniqueSymbols(symbols: string[]): string[] {
  return Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));
}

// Broker order objects are verbose; the agent only needs recent intent/outcome.
// Send a slim, recent slice instead of 20 raw records.
function compactRecentOrders(orders: EquityOrder[]): Array<Record<string, unknown>> {
  return orders.slice(0, 8).map((order) => {
    const quantity = order.filledQuantity ?? order.quantity;
    return {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      state: order.state,
      ...(order.dollarAmount ? { dollarAmount: order.dollarAmount } : {}),
      ...(quantity ? { quantity } : {}),
      ...(order.averagePrice ? { avgPrice: order.averagePrice } : {}),
      createdAt: order.createdAt
    };
  });
}

function compactMarketScanForPrompt(marketScan?: MarketScan) {
  if (!marketScan) return undefined;
  const hasAskData = marketScan.topCandidates.some((quote) => quote.ask && quote.ask > 0);
  return {
    source: marketScan.source,
    generatedAt: marketScan.generatedAt,
    scannedSymbols: marketScan.scannedSymbols,
    returnedQuotes: marketScan.returnedQuotes,
    cacheTtlMs: marketScan.cacheTtlMs,
    cached: marketScan.cached,
    hasAskData,
    topCandidates: marketScan.topCandidates.map((quote, index) => ({
      rank: index + 1,
      symbol: quote.symbol,
      price: quote.price,
      bid: quote.bid,
      ask: quote.ask,
      volume: quote.volume,
      marketCap: quote.marketCap,
      intradayChangePct: quote.intradayChangePct,
      peRatio: quote.peRatio,
      eps: quote.eps,
      dividendYield: quote.dividendYield,
      fcfYieldPct: quote.fcfYield,
      debtToEquity: quote.debtToEquity,
      epsGrowth: quote.epsGrowth,
      newsSentiment: quote.sentiment,
      insiderSentiment: quote.insiderSentiment,
      senateTradesNet: quote.senateTrades,
      smartMoneyEvidence: quote.evidenceBulletins?.slice(0, 3),
      analystRating: quote.analystRating,
      analystScore: quote.analystScore,
      headlines: quote.headlines?.slice(0, 2),
      sector: quote.sector,
      industry: quote.industry,
      positionMarketValue: quote.positionMarketValue,
      score: quote.score,
      factorBreakdown: quote.factorBreakdown,
      provider: quote.provider,
      asOf: quote.asOf
    })),
    instructions: hasAskData
      ? "Ask-relative buy limits are allowed only for candidates that include ask."
      : "No ask prices are available in this scan. Do not invent ask-relative limit prices."
  };
}

function fallbackProposal(input: {
  policyAllowlist: string[];
  portfolio: Portfolio;
  positions: EquityPosition[];
}): TradeProposal[] {
  const allowed = new Set(input.policyAllowlist.map(normalizeSymbol));
  const candidates = input.positions
    .filter((position) => allowed.has(normalizeSymbol(position.symbol)))
    .map((position) => ({
      symbol: normalizeSymbol(position.symbol),
      exposurePct: input.portfolio.totalMarketValue > 0 ? (position.marketValue / input.portfolio.totalMarketValue) * 100 : 0
    }))
    .sort((a, b) => a.exposurePct - b.exposurePct);

  const symbol = candidates[0]?.symbol ?? input.policyAllowlist.map(normalizeSymbol)[0];
  if (!symbol) return [];
  return [
    {
      symbol,
      side: "buy",
      type: "market",
      dollarAmount: 10,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale:
        "Development fallback: OPENAI_API_KEY is not configured, so this is a simple mock rebalance suggestion toward the lowest-exposure allowed holding, not an LLM research recommendation.",
      tradeThesisTag: "Development Fallback",
      entryMarketRegime: "Mock Regime"
    }
  ];
}

function sanitizeProposals(proposals: TradeProposal[], max = 3): TradeProposal[] {
  return proposals
    .filter((proposal) => proposal.symbol && proposal.side && proposal.type)
    .slice(0, max)
    .map((proposal) => ({
      ...proposal,
      symbol: normalizeSymbol(proposal.symbol),
      quantity: proposal.quantity ?? undefined,
      dollarAmount: proposal.dollarAmount ?? undefined,
      limitPrice: proposal.limitPrice ?? undefined,
      stopPrice: proposal.stopPrice ?? undefined,
      timeInForce: proposal.timeInForce ?? "gfd",
      marketHours: proposal.marketHours ?? "regular_hours",
      tradeThesisTag: proposal.tradeThesisTag ?? undefined,
      entryMarketRegime: proposal.entryMarketRegime ?? undefined
    }));
}

export async function reconcilePendingFills(gateway: RobinhoodGateway, accountNumber: string): Promise<void> {
  const pending = listFillEvents(accountNumber, "live").filter(
    (fill) => fill.status === "pending_reconciliation" && fill.brokerOrderId
  );
  if (pending.length === 0) return;

  try {
    const brokerOrders = await gateway.getEquityOrders(accountNumber);
    for (const fill of pending) {
      const matched = brokerOrders.find((bo) => bo.id === fill.brokerOrderId);
      if (!matched) continue;

      if (matched.state === "filled") {
        const price = matched.averagePrice ?? fill.price;
        const qty = matched.filledQuantity ?? fill.quantity;
        const notional = price * qty;
        
        updateFillEvent(fill.id, {
          status: "filled",
          price,
          quantity: qty,
          notional,
          filledAt: matched.updatedAt ?? new Date().toISOString(),
          raw: {
            ...((fill.raw as Record<string, unknown>) ?? {}),
            reconciliation: matched
          }
        });
        
        audit("fill_reconciled", {
          fillId: fill.id,
          symbol: fill.symbol,
          status: "filled",
          price,
          quantity: qty
        });
      } else if (["cancelled", "rejected", "failed"].includes(matched.state)) {
        updateFillEvent(fill.id, {
          status: matched.state,
          raw: {
            ...((fill.raw as Record<string, unknown>) ?? {}),
            reconciliation: matched
          }
        });
        
        audit("fill_reconciled", {
          fillId: fill.id,
          symbol: fill.symbol,
          status: matched.state
        });
      }
    }
  } catch (error) {
    console.error("[reconciliation] failed to reconcile pending fills:", error);
  }
}

export function generateProactiveRiskProposals(
  positions: EquityPosition[],
  currentPrices: Record<string, number>,
  policy: TradingPolicy
): TradeProposal[] {
  const proactiveProposals: TradeProposal[] = [];
  const stopLossPct = policy.riskRules.stopLossPct ?? 0;
  const takeProfitPct = policy.riskRules.takeProfitPct ?? 0;

  if (stopLossPct > 0 || takeProfitPct > 0) {
    for (const pos of positions) {
      if (pos.quantity <= 0.000001 || pos.averageCost <= 0) continue;
      const currentPrice = currentPrices[normalizeSymbol(pos.symbol)] ?? (pos.marketValue / pos.quantity);
      if (!currentPrice || currentPrice <= 0) continue;

      const returnPct = ((currentPrice - pos.averageCost) / pos.averageCost) * 100;

      let reason = "";
      if (stopLossPct > 0 && returnPct <= -stopLossPct) {
        reason = `Proactive stop-loss exit: ${pos.symbol} returned ${returnPct.toFixed(2)}% breaching -${stopLossPct}% limit.`;
      } else if (takeProfitPct > 0 && returnPct >= takeProfitPct) {
        reason = `Proactive take-profit trim: ${pos.symbol} returned ${returnPct.toFixed(2)}% breaching ${takeProfitPct}% limit.`;
      }
      if (reason) {
        proactiveProposals.push({
          symbol: normalizeSymbol(pos.symbol),
          side: "sell",
          type: "market",
          quantity: pos.quantity,
          timeInForce: "gfd",
          marketHours: "regular_hours",
          rationale: reason,
          tradeThesisTag: "Risk-Exit",
          entryMarketRegime: "Active Risk Check"
        });
      }
    }
  }
  return proactiveProposals;
}
