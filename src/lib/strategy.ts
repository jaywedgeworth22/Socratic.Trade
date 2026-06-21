import {
  acquireStrategyLock,
  audit,
  dailyExecutionStats,
  finishStrategyRun,
  getActiveConnectedAccount,
  getPolicy,
  getProposal,
  getStrategyPrompt,
  insertProposal,
  insertStrategyRun,
  listFillEvents,
  notionalInLastMinutes,
  releaseStrategyLock,
  setPolicy,
  updateProposalStatus,
  updateFillEvent
} from "./db";
import { mergeQuoteData, pricePosition52w, scanMarket } from "./market";
import { deriveMetrics } from "./derived-metrics";
import { deriveMacroMetrics } from "./macro-metrics";
import { computeMarketInternals } from "./market-internals";
import { getMarketSignals } from "./market-signals";
import { fetchMacroData, pruneMacro, determineMarketRegime, type MacroData } from "./macro";
import { buildCandidateEvidence } from "./evidence";
import { deriveExecutionState, llmExecutionMode, llmModeClarification, type ExecutionAccount } from "./execution-mode";
import { LLM_OUTPUT_TOKEN_CAPS, withLlmRequestBounds, type OpenAiTransport } from "./llm-request";
import { materializeSkippedCandidateCounterfactuals } from "./counterfactual-learning";
import { normalizeSymbol } from "./money";
import { sendNotification } from "./notifications";
import {
  getConfidenceCalibration,
  getFactorScorecard,
  getPaperPortfolioProjection,
  getRegimeScorecard,
  getSectorScorecard,
  getSignalEfficacy,
  getSkippedCandidateReturns,
  getThesisRegimeScorecard,
  getThesisScorecard,
  recordFillFromProposal,
  recordPortfolioSnapshot
} from "./performance";
import { allowedSymbolsForPolicy, evaluateTradeProposal } from "./policy";
import { expireStalePendingProposals, revalidatePendingProposals } from "./proposal-revalidation";
import { getTaxSummary, getUserWashSaleLockedSymbols } from "./tax";
import { getBrokerGateway } from "./broker";
import type { BrokerGateway } from "./types";
import { generateReflectionSummary } from "./post-mortem";
import { emitDashboardEvent } from "./events";
import { getInternalSetting, getUserSetting, resolveApiKey, setInternalSetting } from "./db";
import { withLlmGeneration } from "./observability";
import { debateProposal } from "./red-team";
import { summarizeOpenAiRequest, summarizeOpenAiResponseText, summarizeTradeProposals } from "./telemetry-sanitize";
import type { EquityOrder, EquityPosition, FillSource, MarketScan, Portfolio, TradingPolicy, TradeProposal } from "./types";

/**
 * How many top-ranked-but-skipped candidates to persist with full evidence each run.
 * `scanMarket` already caps the scored universe (~30 names, score >= 40), so this
 * effectively covers the whole skipped set while bounding audit-row growth. This log
 * is for learning only (never sent to the LLM), so size affects storage, not tokens.
 */
const MAX_SKIPPED_EVIDENCE = 25;
const DEFAULT_RED_TEAM_CONVICTION_THRESHOLD = 80;

export interface StrategyResult {
  runId: string;
  status: "completed" | "failed";
  summary: string;
  proposals: Array<{ proposal: TradeProposal; status: string; reasons: string[]; orderId?: string }>;
  marketScan?: MarketScan;
}

export async function runStrategyOnce(userId: string = "local"): Promise<StrategyResult> {
  // Run lock: prevent overlapping runs from double-counting daily limits.
  if (!acquireStrategyLock(userId)) {
    return { runId: "", status: "failed", summary: "A strategy run is already in progress.", proposals: [] };
  }

  const runId = crypto.randomUUID();
  insertStrategyRun(runId, userId);
  let result: StrategyResult;

  try {
    const policy = getPolicy(userId);
    const activeAccount = getActiveConnectedAccount(userId);
    const executionState = deriveExecutionState(policy, activeAccount);
    if (!policy.accountNumber) throw new Error("No account selected.");
    if (policy.systemState === "halted") throw new Error("System is halted.");

    const gateway = getBrokerGateway(policy, userId);
    await reconcilePendingFills(gateway, policy.accountNumber, userId);
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
    const baseMarketScan = await scanMarket(allowedSymbols, positions, policy.scoringWeights, userId);
    const quoteSymbols = uniqueSymbols(baseMarketScan.topCandidates.map((quote) => quote.symbol));
    const marketScan = mergeQuoteData(baseMarketScan, await gateway.getEquityQuotes(policy.accountNumber, quoteSymbols));
    const daily = dailyExecutionStats(policy.accountNumber, new Date(), userId);
    const washSaleLockedSymbols = getUserWashSaleLockedSymbols(userId, new Date());

    // In Test mode, decisions run against the standalone local account
    // (starting cash + prior simulated fills, marked to live prices).
    const currentPrices = currentPricesFromScan(marketScan);
    const account = executionState.usesLocalSimulation
      ? getPaperPortfolioProjection({ accountNumber: policy.accountNumber, startingCash: policy.paperStartingCash, currentPrices, userId })
      : { portfolio, positions };
    const workingPortfolio = account.portfolio;
    const workingPositions = account.positions;

    // Supplemental tasks before generating new ideas — keep the approval queue honest so a
    // human never mistakes an hours/days-old pending proposal for a fresh recommendation:
    //   (1) deterministic hard-expiry of anything past policy.proposalExpiryMinutes, then
    //   (2) an LLM re-check ("does this still stand?") of pending proposals due on their
    //       cadence (regular market hours only) against this run's fresh scan — withdrawing
    //       what no longer holds, stamping the survivors as re-validated.
    const expiry = await expireStalePendingProposals({ userId, policy, accountNumber: policy.accountNumber });
    const revalidation = await revalidatePendingProposals({ userId, policy, accountNumber: policy.accountNumber, marketScan })
      .catch((e) => {
        console.error("[revalidation] run error:", e);
        return null;
      });

    const proactiveProposals = generateProactiveRiskProposals(workingPositions, currentPrices, policy);

    let ragContext = "";
    try {
      const { retrieveContext } = await import("./vector-db");
      const topSymbols = marketScan.topCandidates.slice(0, 3).map(c => c.symbol);
      const contexts = await Promise.all(topSymbols.map(sym => 
        retrieveContext(`Significant financial events, SEC filings, and macro catalysts for ${sym}`, sym, 3, userId)
      ));
      const validContexts = contexts.flat().filter(Boolean);
      if (validContexts.length > 0) {
        ragContext = validContexts.join("\n\n");
      }
    } catch (e) {
      console.warn("[Strategy] Skipping RAG context, vector-db or keys might not be available.");
    }

    const llmProposals = await proposeTrades({
      userId,
      policyAllowlist: allowedSymbols,
      prompt: getStrategyPrompt(userId),
      policy,
      activeAccount,
      portfolio: workingPortfolio,
      positions: workingPositions,
      recentOrders: compactRecentOrders(orders),
      marketScan,
      dailyNotionalUsed: daily.notional,
      dailyOrderCount: daily.orderCount,
      ragContext
    });

    const learningSource: FillSource = executionState.usesLocalSimulation ? "paper" : "live";
    const sizedProposals = llmProposals.map((p) => applyDeterministicSizing(p, policy, workingPortfolio, learningSource, userId));

    const debatedProposals: TradeProposal[] = [];
    for (const proposal of sizedProposals) {
      if (shouldRunRedTeamDebate(proposal, policy)) {
        const isBullish = proposal.side === "buy" || proposal.side === "cover";
        const quote = marketScan.topCandidates.find(c => normalizeSymbol(c.symbol) === normalizeSymbol(proposal.symbol));
        const redTeamResult = await debateProposal(proposal, quote, isBullish, userId);
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
        insertProposal({ userId,  id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, status: "blocked" });
        await sendNotification(
          {
            type: "block",
            title: `${normalizedProposal.side.charAt(0).toUpperCase() + normalizedProposal.side.slice(1)} ${normalizedProposal.symbol} blocked`,
            payload: { runId, proposalId, decision, proposal: normalizedProposal }
          },
          { policy, userId }
        );
        autoRevertOnCapBreach(decision.reasons, policy, userId);
        results.push({ proposal: normalizedProposal, status: "blocked", reasons: decision.reasons });
        continue;
      }

      const review = await gateway.reviewEquityOrder({ accountNumber: policy.accountNumber, ...normalizedProposal });
      const dailyNow = dailyExecutionStats(policy.accountNumber, new Date(), userId);
      const hourlyNow = notionalInLastMinutes(policy.accountNumber, 60, new Date(), userId);
      const decision = evaluateTradeProposal(normalizedProposal, {
        policy,
        portfolio: workingPortfolio,
        positions: workingPositions,
        dailyNotionalUsed: dailyNow.notional,
        hourlyNotionalUsed: hourlyNow.notional,
        dailyOrderCount: dailyNow.orderCount,
        estimatedNotional: review.estimatedNotional,
        marketScan,
        washSaleLockedSymbols
      });

      if (!decision.approved) {
        const proposalId = crypto.randomUUID();
        insertProposal({ userId,  id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, review, estimatedNotional: review.estimatedNotional, status: "blocked" });
        await sendNotification(
          {
            type: "block",
            title: `${normalizedProposal.side.charAt(0).toUpperCase() + normalizedProposal.side.slice(1)} ${normalizedProposal.symbol} blocked`,
            payload: { runId, proposalId, decision, review, proposal: normalizedProposal }
          },
          { policy, userId }
        );
        autoRevertOnCapBreach(decision.reasons, policy, userId);
        results.push({ proposal: normalizedProposal, status: "blocked", reasons: decision.reasons });
        continue;
      }

      if (policy.strategyAuthority === "propose") {
        const proposalId = crypto.randomUUID();
        insertProposal({ userId,  id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, review, estimatedNotional: review.estimatedNotional, status: "proposed" });
        await sendNotification(
          { type: "pending_approval", title: `${normalizedProposal.symbol} awaiting approval`, payload: { runId, proposalId, proposal: normalizedProposal, review } },
          { policy, userId }
        );
        results.push({ proposal: normalizedProposal, status: "proposed", reasons: [] });
        continue;
      }

      if (executionState.usesLocalSimulation) {
        const proposalId = crypto.randomUUID();
        insertProposal({ userId,  id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, review, estimatedNotional: review.estimatedNotional, status: "paper" });
        const fill = recordFillFromProposal({
          userId,
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
            title: `${normalizedProposal.symbol} Test ${normalizedProposal.side.charAt(0).toUpperCase() + normalizedProposal.side.slice(1)}`,
            payload: { runId, proposalId, fill }
          },
          { policy, userId }
        );
        results.push({ proposal: normalizedProposal, status: "paper", reasons: [] });
        continue;
      }

      const refId = crypto.randomUUID();
      const execution = await gateway.placeEquityOrder({ accountNumber: policy.accountNumber, ...normalizedProposal, refId });
      const proposalId = crypto.randomUUID();
      insertProposal({ userId, 
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
        userId,
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
        { policy, userId }
      );
      // Push so open dashboards refresh on an autonomously-placed order (the approval path
      // already emits this; the run-loop placement previously did not).
      emitDashboardEvent({ type: "order", userId, at: new Date().toISOString(), detail: { runId, proposalId, symbol: normalizedProposal.symbol, orderId: execution.orderId } });
      results.push({ proposal: normalizedProposal, status: "placed", reasons: [], orderId: execution.orderId });
    }

    // Phase 10 B2 — full EvidenceDigest for the WHOLE scored set (chosen AND skipped):
    // factor sub-scores, source freshness, bulletins, sector, regime, and a decision-time
    // reference price. Persisting the skipped names (not just what we bought) is what lets
    // later learning run counterfactuals ("names you passed that then ran") and attribute
    // outcomes to factors. The run regime is deterministic and shared across candidates.
    const runRegime = determineMarketRegime(await fetchMacroData(userId));
    const quoteBySymbol = new Map((marketScan?.topCandidates ?? []).map((q) => [normalizeSymbol(q.symbol), q]));
    const chosenSymbols = new Set(results.map((r) => normalizeSymbol(r.proposal.symbol)));

    const chosenEvidence = results.map((r) =>
      buildCandidateEvidence(quoteBySymbol.get(normalizeSymbol(r.proposal.symbol)), {
        symbol: r.proposal.symbol,
        chosen: true,
        regime: runRegime,
        side: r.proposal.side,
        status: r.status,
        thesisTag: r.proposal.tradeThesisTag
      })
    );
    const skippedEvidence = (marketScan?.topCandidates ?? [])
      .filter((candidate) => !chosenSymbols.has(normalizeSymbol(candidate.symbol)))
      .slice(0, MAX_SKIPPED_EVIDENCE)
      .map((candidate) => buildCandidateEvidence(candidate, { symbol: candidate.symbol, chosen: false, regime: runRegime }));

    // Counterfactual decision index: which names we bought vs the top-ranked names we
    // passed. The skipped half now carries full evidence (was symbol/score/sector/change
    // only), so post-mortems can compare like-for-like without re-deriving the scan.
    audit("candidates_considered", {
      runId,
      chosen: results.map((r) => ({ symbol: r.proposal.symbol, side: r.proposal.side, status: r.status, thesisTag: r.proposal.tradeThesisTag })),
      topSkipped: skippedEvidence
    }, userId);

    // SignalSnapshot: the full scored set, each a complete CandidateEvidence digest.
    // getSignalEfficacy joins closed lots → signals by runId|symbol, so skipped entries
    // (no fills) are simply never matched.
    audit("signal_snapshot", {
      runId,
      asOf: new Date().toISOString(),
      signals: [...chosenEvidence, ...skippedEvidence]
    }, userId);
    void materializeSkippedCandidateCounterfactuals(userId, { auditLimit: 100, pendingLimit: 25 })
      .catch((e) => console.error("[counterfactual-learning] materialization error:", e));

    const placed = results.filter((r) => r.status === "placed").length;
    const paperCount = results.filter((r) => r.status === "paper").length;
    const proposed = results.filter((r) => r.status === "proposed").length;
    const tradeCount = placed + paperCount + proposed;
    const tradeNoun = executionState.usesLocalSimulation ? "Test Trade" : "Trade";
    const summary = [
      `Evaluated ${results.length} proposal(s).`,
      `Proposed ${tradeCount} ${tradeNoun}${tradeCount === 1 ? "" : "s"}.`,
      placed > 0 ? `Placed: ${placed}.` : "",
      paperCount > 0 ? `Test: ${paperCount}.` : "",
      proposed > 0 ? `Awaiting approval: ${proposed}.` : "",
      expiry.expired > 0 ? `Expired ${expiry.expired} stale proposal${expiry.expired === 1 ? "" : "s"}.` : "",
      revalidation && (revalidation.withdrawn > 0 || revalidation.reaffirmed > 0)
        ? `Re-checked ${revalidation.checked} pending: kept ${revalidation.reaffirmed}, withdrew ${revalidation.withdrawn}.`
        : ""
    ]
      .filter(Boolean)
      .join(" ");

    finishStrategyRun(runId, "completed", summary, userId);
    // Always snapshot the real account; snapshot the local simulation too in Test mode.
    recordPortfolioSnapshot({ userId, runId, accountNumber: policy.accountNumber, source: "live", portfolio, positions });
    if (executionState.usesLocalSimulation) {
      const paperProjection = getPaperPortfolioProjection({
        accountNumber: policy.accountNumber,
        startingCash: policy.paperStartingCash,
        currentPrices,
        userId
      });
      recordPortfolioSnapshot({
        userId,
        runId,
        accountNumber: policy.accountNumber,
        source: "paper",
        portfolio: paperProjection.portfolio,
        positions: paperProjection.positions
      });
    }
    result = { runId, status: "completed", summary, proposals: results, marketScan };
    
    // Phase 7: Async trigger post-mortem reflection
    generateReflectionSummary(policy.accountNumber, userId).catch((e) => console.error("Post-mortem error:", e));
    
  } catch (error) {
    const summary = error instanceof Error ? error.message : "Strategy failed.";
    finishStrategyRun(runId, "failed", summary, userId);
    result = { runId, status: "failed", summary, proposals: [] };
    const policy = getPolicy(userId);
    if (summary === "Kill switch is active.") {
      await sendNotification({ type: "kill_switch", title: "Kill switch blocked strategy run", payload: { runId, summary } }, { policy, userId });
    } else {
      await sendNotification({ type: "run_failed", title: "Strategy run failed", payload: { runId, summary } }, { policy, userId });
    }
  } finally {
    releaseStrategyLock(userId);
  }

  // Audit is written here (inside the domain fn) so the scheduler path records it too.
  audit("strategy_run", result, userId);
  // Push a dashboard event so open clients refresh immediately instead of waiting for their
  // next poll (the SSE bus is in-process; no-op when nothing is subscribed).
  emitDashboardEvent({ type: "run-complete", userId, at: new Date().toISOString(), detail: { runId } });
  return result;
}

export function shouldRunRedTeamDebate(proposal: TradeProposal, policy: TradingPolicy): boolean {
  return (proposal.confidenceScore ?? 0) >= redTeamConvictionThresholdForPolicy(policy);
}

export function redTeamConvictionThresholdForPolicy(policy: TradingPolicy): number {
  const threshold = policy.tuning?.redTeamConvictionThreshold;
  if (threshold === undefined || !Number.isFinite(threshold)) return DEFAULT_RED_TEAM_CONVICTION_THRESHOLD;
  return Math.max(0, Math.min(100, threshold));
}

function applyDeterministicSizing(proposal: TradeProposal, policy: TradingPolicy, portfolio: Portfolio, source: FillSource, userId: string = "local"): TradeProposal {
  if (proposal.side === "sell" || proposal.side === "cover") return proposal; // Preserve exits
  const account = policy.accountNumber;
  if (!account) return proposal;

  const regimeScorecard = getThesisRegimeScorecard(account, source, {}, userId);
  const thesisScorecard = getThesisScorecard(account, source, {}, userId);
  
  const comboStat = regimeScorecard.find(s => s.thesisTag === proposal.tradeThesisTag && s.regime === proposal.entryMarketRegime);
  const thesisStat = thesisScorecard.find(s => s.thesisTag === proposal.tradeThesisTag);

  // Prefer the thesis×regime bucket once it has enough samples; otherwise the thesis bucket.
  const stat = comboStat && comboStat.trades >= 5 ? comboStat : thesisStat;
  const winRate = stat?.shrunkWinRate ?? 50;
  const avgReturn = stat?.shrunkAvgReturnPct ?? 0; // shrunk realized edge (%)
  const conviction = (proposal.confidenceScore ?? 50) / 100;

  // Edge-aware Kelly-lite: scale by win rate AND conviction AND the realized EDGE.
  // A thesis that wins often but with no/negative expectancy shouldn't get full size;
  // one with a proven positive edge earns more. This uses the learned shrunk avg return
  // so a handful of lucky trades can't inflate sizing.
  const edgeFactor = avgReturn > 1 ? 1 : avgReturn >= 0 ? 0.7 : avgReturn > -1 ? 0.5 : 0.3;
  const multiplier = (winRate / 100) * conviction * edgeFactor;

  // Bounds are configurable (policy.tuning.sizingFloorPct / sizingCeilingPct); default 10–100%.
  const floor = (policy.tuning?.sizingFloorPct ?? 10) / 100;
  const ceiling = (policy.tuning?.sizingCeilingPct ?? 100) / 100;
  const boundedMultiplier = Math.max(floor, Math.min(ceiling, multiplier));
  
  const effectiveMaxOrderNotional = Math.min(
    policy.maxOrderNotional ?? Infinity,
    policy.maxOrderPctOfNav ? (policy.maxOrderPctOfNav / 100) * portfolio.totalMarketValue : Infinity
  );
  const targetNotional = Math.floor(effectiveMaxOrderNotional * boundedMultiplier);

  return {
    ...proposal,
    dollarAmount: targetNotional,
    quantity: undefined, // Override any LLM-guessed quantity to force notional routing
    rationale: proposal.rationale + `\n\n[Sizing] Sized to $${targetNotional} (${Math.round(boundedMultiplier * 100)}% of max) from ${winRate}% win rate, ${avgReturn}% avg edge, and ${Math.round(conviction * 100)}% AI conviction.`
  };
}

// R1 §1.4.3 — if an autonomous ("decide") run trips a notional/order cap, drop the account back to
// "propose" so a human is back in the loop before any further orders. Returns true if it reverted.
const CAP_BREACH_REASONS = ["Daily notional limit", "Hourly notional limit", "Daily order count limit"];
function autoRevertOnCapBreach(reasons: string[] | undefined, policy: TradingPolicy, userId: string): boolean {
  if (policy.strategyAuthority !== "decide" || !reasons) return false;
  if (!reasons.some((r) => CAP_BREACH_REASONS.some((c) => r.includes(c)))) return false;
  setPolicy({ ...policy, strategyAuthority: "propose" }, userId);
  audit("policy_violation_cap_exceeded", { reasons, from: "decide", revertedTo: "propose" }, userId);
  return true;
}

export async function executeProposal(proposalId: string, userId: string = "local"): Promise<{
  status: string;
  orderId?: string;
  reasons?: string[];
}> {
  const policy = getPolicy(userId);
  const activeAccount = getActiveConnectedAccount(userId);
  const executionState = deriveExecutionState(policy, activeAccount);
  if (!policy.accountNumber) throw new Error("No account selected.");
  if (policy.systemState === "halted") throw new Error("System is halted.");

  const row = getProposal(proposalId, userId);
  if (!row) throw new Error("Proposal not found.");
  if (row.status !== "proposed") throw new Error(`Proposal is already ${row.status}.`);

  const proposal = row.proposal;
  const gateway = getBrokerGateway(policy, userId);

  const [portfolio, positions] = await Promise.all([
    gateway.getPortfolio(policy.accountNumber),
    gateway.getEquityPositions(policy.accountNumber)
  ]);
  const allowedSymbols = allowedSymbolsForPolicy(policy);
  const approvalScanBase = await scanMarket(allowedSymbols, positions, policy.scoringWeights, userId);
  const approvalQuoteSymbols = uniqueSymbols([...approvalScanBase.topCandidates.map((quote) => quote.symbol), proposal.symbol]);
  const approvalScan = mergeQuoteData(
    approvalScanBase,
    await gateway.getEquityQuotes(policy.accountNumber, approvalQuoteSymbols)
  );

  // In Test mode, evaluate the approval against the standalone local account.
  const currentPrices = currentPricesFromScan(approvalScan);
  const account = executionState.usesLocalSimulation
    ? getPaperPortfolioProjection({ accountNumber: policy.accountNumber, startingCash: policy.paperStartingCash, currentPrices, userId })
    : { portfolio, positions };

  const tradability = await gateway.getEquityTradability(policy.accountNumber, [proposal.symbol]);
  if (!tradability[proposal.symbol]?.tradable) {
    const reason = tradability[proposal.symbol]?.reason ?? "Symbol is not tradable.";
    updateProposalStatus(proposalId, "blocked", undefined, undefined, undefined, userId);
    audit("proposal_approved", { proposalId, symbol: proposal.symbol, side: proposal.side, action: "approval", result: "blocked", reason }, userId);
    await sendNotification(
      {
        type: "block",
        title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} blocked`,
        payload: { proposalId, reason, proposal }
      },
      { policy, userId }
    );
    return { status: "blocked", reasons: [reason] };
  }

  const review = await gateway.reviewEquityOrder({ accountNumber: policy.accountNumber, ...proposal });
  const daily = dailyExecutionStats(policy.accountNumber, new Date(), userId);
  const hourly = notionalInLastMinutes(policy.accountNumber, 60, new Date(), userId);
  const decision = evaluateTradeProposal(proposal, {
    policy,
    portfolio: account.portfolio,
    positions: account.positions,
    dailyNotionalUsed: daily.notional,
    hourlyNotionalUsed: hourly.notional,
    dailyOrderCount: daily.orderCount,
    estimatedNotional: review.estimatedNotional,
    marketScan: approvalScan,
    washSaleLockedSymbols: getUserWashSaleLockedSymbols(userId, new Date())
  });

  if (!decision.approved) {
    updateProposalStatus(proposalId, "blocked", undefined, review, review.estimatedNotional, userId);
    audit("proposal_approved", {
      proposalId,
      symbol: proposal.symbol,
      side: proposal.side,
      action: "approval",
      result: "blocked",
      reasons: decision.reasons
    }, userId);
    await sendNotification(
      {
        type: "block",
        title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} blocked`,
        payload: { proposalId, decision, review, proposal }
      },
      { policy, userId }
    );
    autoRevertOnCapBreach(decision.reasons, policy, userId);
    return { status: "blocked", reasons: decision.reasons };
  }

  if (executionState.usesLocalSimulation) {
    updateProposalStatus(proposalId, "paper", undefined, review, review.estimatedNotional, userId);
    const fill = recordFillFromProposal({
      userId,
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
      currentPrices: { ...currentPrices, ...(fill.price > 0 ? { [fill.symbol]: fill.price } : {}) },
      userId
    });
    recordPortfolioSnapshot({
      userId,
      runId: row.runId,
      accountNumber: row.accountNumber,
      source: "paper",
      portfolio: paperProjection.portfolio,
      positions: paperProjection.positions
    });
    audit("proposal_approved", { proposalId, symbol: proposal.symbol, side: proposal.side, action: "approval", result: "paper" }, userId);
    await sendNotification(
      {
        type: "fill",
        title: `${proposal.symbol} Test ${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)}`,
        payload: { proposalId, fill }
      },
      { policy, userId }
    );
    return { status: "paper" };
  }

  const refId = crypto.randomUUID();
  const execution = await gateway.placeEquityOrder({ accountNumber: policy.accountNumber, ...proposal, refId });
  updateProposalStatus(proposalId, "placed", execution.orderId, review, review.estimatedNotional, userId);
  const fill = recordFillFromProposal({
    userId,
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
  }, userId);
  await sendNotification(
    {
      type: "fill",
      title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} ${execution.state}`,
      payload: { proposalId, fill }
    },
    { policy, userId }
  );
  // Push so other open dashboards refresh immediately (the approving client refreshes via its
  // own response).
  emitDashboardEvent({ type: "order", userId, at: new Date().toISOString(), detail: { proposalId, orderId: execution.orderId, symbol: proposal.symbol } });
  return { status: "placed", orderId: execution.orderId };
}

export function rejectProposal(proposalId: string, userId: string = "local"): void {
  const proposal = getProposal(proposalId, userId);
  updateProposalStatus(proposalId, "rejected", undefined, undefined, undefined, userId);
  audit("proposal_rejected", {
    proposalId,
    symbol: proposal?.proposal.symbol,
    side: proposal?.proposal.side,
    action: "rejection"
  }, userId);
  emitDashboardEvent({ type: "proposal", userId, at: new Date().toISOString(), detail: { proposalId, status: "rejected" } });
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

const HOLDING_HORIZON_GUIDE: Record<string, string> = {
  intraday:
    "Holding horizon = INTRADAY/day-trade. Favor liquid, high-momentum, catalyst-driven setups; use tight stops; avoid illiquid names and multi-day fundamental theses; assume positions are flat or trimmed quickly.",
  swing:
    "Holding horizon = SWING (days to a few weeks). Balance momentum/technicals with a near-term catalyst or mean-reversion edge; don't require a multi-quarter fundamental story; size for a days-to-weeks hold.",
  position:
    "Holding horizon = POSITION (weeks to months). Lean on fundamentals (FCF, leverage, EPS growth) and sector/regime fit over intraday noise; tolerate normal volatility; let winners run toward the thesis target.",
  longterm:
    "Holding horizon = LONG-TERM (months to years). Prioritize durable quality/value and secular trends; ignore short-term noise; strongly prefer holding winners past the 1-year mark for long-term tax treatment; trade infrequently."
};

async function proposeTrades(input: {
  userId: string;
  policyAllowlist: string[];
  prompt: string;
  policy: TradingPolicy;
  activeAccount?: ExecutionAccount;
  portfolio: Portfolio;
  positions: EquityPosition[];
  recentOrders: unknown[];
  marketScan?: MarketScan;
  dailyNotionalUsed: number;
  dailyOrderCount: number;
  ragContext?: string;
}): Promise<TradeProposal[]> {
  const openaiKey = resolveApiKey("openai", input.userId);
  if (!openaiKey) return fallbackProposal(input);

  const maxProposals = input.policy.maxProposalsPerRun ?? 3;
  const remainingNotional = Math.max(0, (input.policy.maxDailyNotional ?? Infinity) - input.dailyNotionalUsed);
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

  const currentPrices = currentPricesFromScan(input.marketScan);
  const reflection = getUserSetting(input.userId, "reflection_summary", "");
  const executionState = deriveExecutionState(input.policy, input.activeAccount);
  const source: FillSource = executionState.usesLocalSimulation ? "paper" : "live";
  const thesisScorecard = input.policy.accountNumber ? getThesisScorecard(input.policy.accountNumber, source, {}, input.userId) : [];
  const regimeScorecard = input.policy.accountNumber ? getRegimeScorecard(input.policy.accountNumber, source, {}, input.userId) : [];
  // Multi-dimensional learning: thesis × regime buckets with >=2 closed lots (thin
  // buckets are noise; shrunk rates temper the rest). Top movers by |total P&L|.
  const thesisRegimeScorecard = (input.policy.accountNumber ? getThesisRegimeScorecard(input.policy.accountNumber, source, {}, input.userId) : [])
    .filter((bucket) => bucket.trades >= 2)
    .sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl))
    .slice(0, 8);
  // Signal efficacy: realized win rate of buys that had a congressional/insider tailwind
  // at entry vs the baseline — so the agent learns which evidence actually predicts wins.
  const signalEfficacy = input.policy.accountNumber ? getSignalEfficacy(input.policy.accountNumber, source, {}, input.userId) : [];
  // Confidence calibration: realized outcomes by the agent's own entry confidence band —
  // since confidence now drives position size, this surfaces over/under-confidence.
  const confidenceCalibration = input.policy.accountNumber ? getConfidenceCalibration(input.policy.accountNumber, source, {}, input.userId) : [];
  // Sector learning: realized outcomes grouped by the sector each position was opened in.
  const sectorScorecard = (input.policy.accountNumber ? getSectorScorecard(input.policy.accountNumber, source, {}, input.userId) : [])
    .filter((bucket) => bucket.trades >= 2 && bucket.sector !== "Unknown")
    .sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl))
    .slice(0, 8);
  const factorScorecard = (input.policy.accountNumber ? getFactorScorecard(input.policy.accountNumber, source, {}, input.userId) : [])
    .filter((bucket) => bucket.trades >= 2)
    .sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl))
    .slice(0, 8);
  const skippedCounterfactuals = getSkippedCandidateReturns(currentPrices, input.userId, { limit: 8, maxAgeDays: 14 })
    .filter((row) => row.returnPct >= 3)
    .slice(0, 8);
  const taxSummary = input.policy.accountNumber
    ? getTaxSummary(input.policy.accountNumber, source, currentPrices, input.policy.taxSettings, new Date(), input.userId)
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
  const executionMode = llmExecutionMode(executionState);
  const executionModeClarification = llmModeClarification(executionState);
  const systemPrompt = [
    "You are an autonomous equity trading agent for a Robinhood brokerage account.",
    "",
    "Execution Mode:",
    `Current executionMode is "${executionMode}".`,
    executionModeClarification,
    "Do not call test/local mode Paper mode. Paper, including Alpaca Paper, is a separate broker-hosted sandbox account concept.",
    "",
    "Investment Strategy:",
    input.prompt,
    "",
    "Historical Reflection & Lessons Learned:",
    reflection || "No historical reflection available yet.",
    "",
    "Your realized track record (in the user message):",
    "- `thesisOutcomes`: win rate, average return, and total P&L grouped by `tradeThesisTag`. Use `shrunkWinRate`/`shrunkAvgReturnPct` (Bayesian-shrunk toward neutral) over the raw rates when `trades` is small — a thesis with 2 trades is weak evidence. Lean into thesis types with a positive shrunk track record; be skeptical of or downsize ones that have repeatedly lost. Reuse a proven `tradeThesisTag` when the setup matches.",
    "- `regimeOutcomes`: the same outcomes grouped by `entryMarketRegime`. Compare today's regime (infer it from macroeconomicData, especially VIX and rates) to your history: demand more conviction for thesis/regime combinations that have lost, and size up where this regime has rewarded you.",
    "- `marketBreadth.advancingPct`: share of the broad market advancing today. >60 = broad risk-on (favor adding exposure/momentum); <40 = broad risk-off (tighten, prefer defensive/quality, wary of longs); ~50 = mixed.",
    "- `comboOutcomes`: realized outcomes for specific thesis×regime COMBINATIONS (e.g. a thesis that wins in Tech-Bull but loses in High-Vol). When today's inferred regime matches a combination here, weight that conditional record heavily; prefer shrunk rates for thin buckets.",
    "- `sectorOutcomes`: realized win/return grouped by the SECTOR each position was opened in. Lean toward sectors where your shrunk record is positive; demand more conviction in sectors that have repeatedly lost for you.",
    "- `factorOutcomes`: realized outcomes grouped by the dominant deterministic factor at entry. Use this to calibrate which scoring dimensions have actually paid off for this account.",
    "- `skippedCounterfactuals`: high-scoring skipped candidates that subsequently rose from their decision-time `refPrice` to the current scan price. Use these as missed-opportunity evidence, not as automatic buys.",
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
    HOLDING_HORIZON_GUIDE[input.policy.holdingHorizon ?? "swing"] ?? HOLDING_HORIZON_GUIDE.swing,
    "",
    `When to SELL/TRIM: any position exceeding ${input.policy.maxSymbolExposurePct}% of portfolio value;`,
    `positions down more than ${input.policy.riskRules.stopLossPct ?? 8}% without a clear catalyst;`,
    `positions up more than ${input.policy.riskRules.takeProfitPct ?? 20}% where trimming would improve risk/reward; rebalancing toward better-ranked scan opportunities.`,
    "",
    "Evidence per candidate (in marketScan.topCandidates): factors (sub-scores), fcf, de (debt/equity), epsGr, pb (price/book), shortFloat (% of float sold short), beta, range52w (0=at 52-week low, 100=at 52-week high), secRelStr (today's % move minus its sector's average — positive = outperforming its sector, a relative-strength tell), newsSent, insiderSent, senateNet, smartMoney, rating, news. Justify each proposal from this structured evidence, not vibes.",
    "Backend-derived ratios (computed by us, not invented — present only when their inputs exist): peg = P/E ÷ EPS-growth% (<1 cheap for its growth, >2 pricey; absent for unprofitable or no-growth names); earnYld = earnings yield % = EPS÷price (use this instead of P/E when pe is missing — a negative earnYld means the company is losing money); roe = return-on-equity % (capital efficiency; higher is better, negative = losing money on equity); payout = dividend payout ratio % (>100 = paying out more than it earns, dividend at risk); dollarVolM = daily $ volume in millions (liquidity — prefer names that can absorb the order size without slippage; thin names warrant smaller size or limit orders); spreadBps = bid-ask spread in basis points (execution cost; wide spreads argue for limit orders); grahamNumber = Graham intrinsic-value estimate ($) and marginOfSafety = % the price sits below (positive) or above (negative) it — a value cushion for defensive names; pctFromHigh = % from the 52-week high (0 = at the high/breakout zone, deeply negative = a big pullback); rr52w = reward:risk to the 52-week band (>1 = more upside room to the high than downside to the low). Use these as quantitative cross-checks on valuation, quality, income safety, tradability, and entry timing.",
    "`macroeconomicData` now also carries: dgs3moTreasury/dgs2Treasury (short rates), inflationExpectation10y (10Y breakeven — market-implied inflation), corePCE (the Fed's preferred inflation gauge), realGDPGrowth, initialClaims (weekly labor pulse), hyCreditSpread (high-yield credit spread — a key risk-appetite gauge; widening = risk-off), usdIndex (broad dollar — a strong dollar pressures multinationals/commodities), wtiOil (energy/inflation), and vix3m. Read hyCreditSpread and the curve together for recession risk; read realGDPGrowth vs inflation for the growth/inflation mix.",
    "`macroDerived` (backend-computed from FRED data): curve3m10y = 10Y − 3M in pp (the Fed's preferred recession curve); curve2s10s = 10Y − 2Y in pp (the canonical recession curve — negative = inverted); vixTermStructure = VIX ÷ 3-month VIX (>1 = backwardation/acute near-term fear, <1 = calm contango); yieldCurveSpread = 10Y − Fed funds in pp (negative = inverted curve, a classic recession warning — favor quality/defensives, demand more conviction on cyclicals/high-beta); real10Y = 10Y − CPI in pp (the real risk-free rate — high real rates pressure long-duration/high-multiple growth names); realFedFunds = Fed funds − CPI (>0 = restrictive policy); miseryIndex = unemployment + inflation (higher = more macro stress); equityRiskPremium = market earnings yield − 10Y in pp (low/negative = stocks expensive vs bonds, be selective; high = stocks broadly cheap). Weigh these when setting overall risk posture and sizing.",
    "`marketInternals` (across the scan candidates): breadthPct (full-screener % advancing), advancers/decliners, pctAboveRangeMid (% of names above their 52-week midpoint), medianPE/medianEarnYld (universe valuation), and sectorRotation (avg intraday move per sector, leaders first). Use sectorRotation to favor leadership sectors and to read whether a name's move is sector-wide or name-specific; use breadth to gauge whether risk-taking is being rewarded today.",
    "`marketSignals` (free market-wide gauges): skew = Cboe SKEW (tail-risk/crash-hedging demand; >135–145 = elevated, the market is paying up for downside protection); vvix = volatility of VIX (high = unstable vol, often near turning points); cotSpNonCommNet / cotSpNonCommNetPctOI = large-speculator net positioning in E-mini S&P 500 futures (extreme net-long = crowded/complacent, extreme net-short can precede squeezes); factors1m = trailing ~1-month cumulative returns for the market (mktRf), size (smb), value (hml) and momentum (mom) factors — read this as the current STYLE regime and tilt toward the factors that are working (e.g. positive mom = momentum names favored, positive hml = value favored); marketBreadthPct = % of the ENTIRE US stock universe (~12k names) advancing day-over-day with marketAdvancers/marketDecliners (true breadth — broad participation >55% supports risk-on, narrow <45% argues caution), and marketTopGainers/marketTopLosers are the biggest liquid movers market-wide. Use these to set overall risk posture and style tilt, not as single-name triggers.",
    "Technical/positioning reads: range52w near 100 = sustained strength/breakout (Momentum-Breakout), near 0 = weakness — could be Value/Mean-Reversion or a falling knife, so demand a catalyst. High shortFloat (>15-20%) raises squeeze potential (Short-Squeeze-Risk) but also signals smart-money bearishness — treat as two-sided. High beta (>1.3) means amplified moves: size more cautiously. Low pb can flag value (cross-check quality/leverage).",
    "smartMoney holds freshly-disclosed congressional (and insider) trade bulletins; senateNet is the net count of distinct members buying minus selling. Politicians disclose on a delay and copycat retail flow tends to follow a disclosure — a cluster of recent congressional/insider BUYS is a positioning tailwind worth front-running (size up, tag Insider-Accumulation), and a cluster of SELLS is a caution flag. Treat it as one input among many, not a standalone trigger.",
    "`retrievedFinancialContext` (when present in the user message) contains dynamic RAG snippets from filings/news/context stores. Use it as catalyst evidence, but do not treat it as guaranteed bullish or bearish without corroborating structured market data.",
    "`signalEfficacy` (when present) is YOUR OWN realized track record: the win rate of past buys that had each evidence signal at entry vs the 'All buys (baseline)'. If a signal's shrunkWinRate is at/below baseline, stop over-weighting it; if it beats baseline, lean into it. Let this calibrate how much each evidence type moves your conviction.",
    "`confidenceCalibration` (when present) is your realized win rate grouped by the confidenceScore you assigned at entry. If your high-confidence band does NOT win more than your low-confidence band, you are over-confident — compress your scores toward the middle. Aim for monotonic calibration (higher confidence → higher realized win rate), since confidence drives size.",
    "Your `confidenceScore` (1–100) now deterministically drives position size (higher conviction + a proven thesis edge = larger size). Calibrate it honestly — don't inflate it.",
    THESIS_PLAYBOOK_GUIDE,
    "",
    "Return strict JSON only. No markdown. No text outside the JSON object."
  ].join("\n");

  // Delta-only macro: macro moves slowly, so on repeat runs send just the changed
  // (plus regime-critical) fields and note the rest as unchanged to save tokens.
  const macro = await fetchMacroData(input.userId);
  const macroCacheKey = `last_macro_sent:${input.userId}`;
  const previousMacro = getInternalSetting<MacroData>(macroCacheKey);
  const { macro: macroForPrompt, omitted: macroOmitted } = pruneMacro(macro, previousMacro);
  setInternalSetting(macroCacheKey, macro);
  const macroeconomicData =
    macroOmitted.length > 0
      ? { ...macroForPrompt, unchangedSinceLastRun: macroOmitted }
      : macroForPrompt;

  const currentMarketRegime = determineMarketRegime(macro);

  // Market internals (breadth, sector rotation, median valuation) across the scan candidates,
  // and backend-derived macro metrics (curve spread, real rates, misery index, equity risk
  // premium). The median earnings yield feeds the ERP so it reflects today's actual universe.
  const marketInternals = input.marketScan ? computeMarketInternals(input.marketScan) : undefined;
  const macroDerived = deriveMacroMetrics(macro, { marketEarningsYield: marketInternals?.medianEarnYld });

  // Market-wide regime/sentiment from free, no-key sources (Cboe tail-risk, CFTC positioning,
  // Fama-French factor regime). Cached 6h; failure-tolerant — never blocks a run.
  const marketSignals = await getMarketSignals(input.userId).catch(() => undefined);

  // [PHASE 2 OPTIMIZATION] Total Allowlist Abstraction
  // Instead of sending hundreds of allowed symbols to the LLM, we just tell it to only trade
  // from the provided topCandidates (which the backend pre-filters). We enforce this at the gateway.
  const allowedSymbolsForPrompt = {
    note: "All proposals must strictly be selected from `marketScan.topCandidates`. Do not propose symbols outside this list. You may SELL/TRIM any current position."
  };

  const userContent = {
    currentDate: new Date().toISOString(),
    executionMode,
    executionModeClarification,
    currentMarketRegime,
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
    ...(Object.keys(macroDerived).length > 0 ? { macroDerived } : {}),
    ...(marketInternals ? { marketInternals } : {}),
    ...(marketSignals && Object.keys(marketSignals).length > 0 ? { marketSignals } : {}),
    ...(sectorComposition ? { sectorComposition } : {}),
    ...(thesisScorecard.length > 0 ? { thesisOutcomes: thesisScorecard.slice(0, 12) } : {}),
    ...(regimeScorecard.length > 0 ? { regimeOutcomes: regimeScorecard.slice(0, 8) } : {}),
    ...(thesisRegimeScorecard.length > 0 ? { comboOutcomes: thesisRegimeScorecard } : {}),
    ...(signalEfficacy.length > 1 ? { signalEfficacy } : {}),
    ...(confidenceCalibration.length > 1 ? { confidenceCalibration } : {}),
    ...(sectorScorecard.length > 0 ? { sectorOutcomes: sectorScorecard } : {}),
    ...(factorScorecard.length > 0 ? { factorOutcomes: factorScorecard } : {}),
    ...(skippedCounterfactuals.length > 0 ? { skippedCounterfactuals } : {}),
    ...(taxContext ? { taxContext } : {}),
    ...(input.ragContext ? { retrievedFinancialContext: input.ragContext } : {})
  };

  const url = process.env.OPENAI_API_URL || "https://api.openai.com/v1/responses";
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const isChatCompletions = url.includes("/chat/completions");
  const transport: OpenAiTransport = isChatCompletions ? "chat-completions" : "responses";

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
            confidenceScore: { type: "number", description: "Conviction score from 1 to 100" }
          }
        }
      }
    }
  };

  const body = withLlmRequestBounds(
    isChatCompletions
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
      },
    transport,
    { maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.strategyProposal }
  );

  const bullResult = await withLlmGeneration(
    {
      name: "trading.strategy.bull",
      model,
      userId: input.userId,
      input: summarizeOpenAiRequest(body),
      metadata: {
        endpoint: url,
        transport,
        maxProposals,
        executionMode,
        internalPaperMode: input.policy.paperMode,
        usesLocalSimulation: executionState.usesLocalSimulation,
        currentMarketRegime
      },
      tags: ["strategy", "bull-agent"],
      output: (result) => ({
        ...summarizeOpenAiResponseText(result.text),
        ...summarizeTradeProposals(result.proposals)
      })
    },
    async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${openaiKey}`
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`OpenAI request failed with ${response.status}: ${detail.slice(0, 500)}`);
      }
      const payload = await response.json();
      const text = extractOpenAiText(payload);

      if (!text) {
        throw new Error("Empty response returned from LLM API.");
      }

      const parsed = JSON.parse(text) as { proposals?: TradeProposal[] };
      return { text, proposals: parsed.proposals ?? [] };
    }
  );

  const bullProposals = sanitizeProposals(bullResult.proposals, maxProposals).map(p => ({
    ...p,
    entryMarketRegime: currentMarketRegime
  }));

  // Phase 7: Bear Agent (Red Team) Critique
  const bearSystemPrompt = [
    "You are the Bear Agent (Red Team Risk Manager) for an autonomous trading system.",
    "Your objective is to CRITIQUE the following proposed trades generated by the Bull Agent.",
    "Execution modes are distinct: test/local is the app's local simulator, broker/paper is a broker-hosted sandbox such as Alpaca Paper, and broker/live is a production broker account.",
    "Evaluate each trade against the macro environment, fundamentals (P/B, short float), technicals, insider sentiment, and overall sector concentration risk.",
    "If a trade is too risky, unjustified, or misaligned with current market regimes, REMOVE it from your output.",
    "If a trade is acceptable but needs a tighter stop loss, better limit price, or smaller size, MODIFY it.",
    `If you approve a trade, you MUST set 'tradeThesisTag' to exactly one playbook tag (${THESIS_PLAYBOOK.join(", ")}).`,
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
            "tradeThesisTag"
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
            tradeThesisTag: { enum: THESIS_PLAYBOOK }
          }
        }
      }
    }
  };

  // review plus risk context — not a second copy of the full market scan / allowlist.
  const proposedSymbols = new Set(bullProposals.map((proposal) => normalizeSymbol(proposal.symbol)));
  const candidatesUnderReview = userContent.marketScan?.topCandidates?.filter((candidate) =>
    typeof candidate.sym === "string" && proposedSymbols.has(normalizeSymbol(candidate.sym))
  );
  const bearUserContent = {
    currentDate: userContent.currentDate,
    executionMode: userContent.executionMode,
    executionModeClarification: userContent.executionModeClarification,
    currentMarketRegime: userContent.currentMarketRegime,
    macroeconomicData: userContent.macroeconomicData,
    limits: userContent.limits,
    portfolio: input.portfolio,
    positions: input.positions,
    ...(sectorComposition ? { sectorComposition } : {}),
    ...(thesisScorecard.length > 0 ? { thesisOutcomes: thesisScorecard.slice(0, 12) } : {}),
    ...(regimeScorecard.length > 0 ? { regimeOutcomes: regimeScorecard.slice(0, 8) } : {}),
    ...(thesisRegimeScorecard.length > 0 ? { comboOutcomes: thesisRegimeScorecard } : {}),
    candidatesUnderReview,
    bullAgentProposals: bullProposals
  };

  const bearBody = withLlmRequestBounds(
    isChatCompletions
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
      },
    transport,
    { maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.strategyCritique }
  );

  const bearResult = await withLlmGeneration(
    {
      name: "trading.strategy.bear",
      model,
      userId: input.userId,
      input: summarizeOpenAiRequest(bearBody),
      metadata: {
        endpoint: url,
        transport,
        reviewedProposalCount: bullProposals.length,
        executionMode,
        internalPaperMode: input.policy.paperMode,
        usesLocalSimulation: executionState.usesLocalSimulation,
        currentMarketRegime
      },
      tags: ["strategy", "bear-agent", "red-team"],
      output: (result) => ({
        ...summarizeOpenAiResponseText(result.text),
        ...summarizeTradeProposals(result.proposals),
        fallbackToBull: result.fallbackToBull
      })
    },
    async () => {
      const bearResponse = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${openaiKey}`
        },
        body: JSON.stringify(bearBody)
      });

      if (!bearResponse.ok) {
        console.warn("Bear Agent API failed, falling back to Bull proposals");
        return { text: undefined, proposals: [] as TradeProposal[], fallbackToBull: true };
      }

      const bearPayload = await bearResponse.json();
      const bearText = extractOpenAiText(bearPayload);

      if (!bearText) {
        return { text: undefined, proposals: [] as TradeProposal[], fallbackToBull: true };
      }

      const parsedBear = JSON.parse(bearText) as { proposals?: TradeProposal[] };
      return { text: bearText, proposals: parsedBear.proposals ?? [], fallbackToBull: false };
    }
  );

  if (bearResult.fallbackToBull) {
    return bullProposals;
  }

  return sanitizeProposals(bearResult.proposals, maxProposals).map(p => ({
    ...p,
    entryMarketRegime: currentMarketRegime
  }));
}

function extractOpenAiText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as {
    output_text?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
    output?: Array<{ content?: Array<{ text?: unknown }> }>;
  };
  if (typeof root.output_text === "string") return root.output_text;
  const chatText = root.choices?.[0]?.message?.content;
  if (typeof chatText === "string") return chatText;
  const responseText = root.output?.flatMap((item) => item.content ?? []).find((item) => typeof item.text === "string")?.text;
  return typeof responseText === "string" ? responseText : undefined;
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
    topCandidates: marketScan.topCandidates
      .filter(quote => quote.score >= 40) // [PHASE 2 OPTIMIZATION] Strict backend pre-filtering
      .map(compactCandidateForPrompt),
    instructions: hasAskData
      ? "Ask-relative buy limits are allowed only for candidates that include ask."
      : "No ask prices are available in this scan. Do not invent ask-relative limit prices."
  };
}

function compactCandidateForPrompt(quote: MarketScan["topCandidates"][number], index: number): Record<string, unknown> {
  return compactPromptObject({
    rank: index + 1,
    sym: quote.symbol,
    px: quote.price,
    bid: quote.bid,
    ask: quote.ask,
    vol: quote.volume,
    mktCap: quote.marketCap,
    chgPct: quote.intradayChangePct,
    pe: quote.peRatio,
    eps: quote.eps,
    div: quote.dividendYield,
    fcf: quote.fcfYield,
    de: quote.debtToEquity,
    epsGr: quote.epsGrowth,
    pb: quote.pbRatio,
    shortFloat: quote.shortPercentOfFloat,
    beta: quote.beta,
    range52w: pricePosition52w(quote),
    // Backend-derived ratios (PEG, earnings yield, ROE, payout, $ volume, spread) are
    // computed deterministically, then omitted when their inputs are unavailable.
    ...deriveMetrics(quote),
    secRelStr: quote.sectorRelStrength,
    newsSent: quote.sentiment,
    insiderSent: quote.insiderSentiment,
    senateNet: quote.senateTrades,
    smartMoney: quote.evidenceBulletins?.slice(0, 3),
    rating: quote.analystRating,
    ratingScore: quote.analystScore,
    news: quote.headlines?.slice(0, 2),
    sec: quote.sector,
    ind: quote.industry,
    posMV: quote.positionMarketValue,
    score: quote.score,
    factors: quote.factorBreakdown,
    provider: quote.provider,
    asOf: quote.asOf
  });
}

function compactPromptObject(values: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (key === "posMV" && value === 0) continue;
    compacted[key] = value;
  }
  return compacted;
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
        "Development fallback: OPENAI_API_KEY is not configured, so this is a simple rule-based rebalance suggestion toward the lowest-exposure allowed holding, not an LLM research recommendation.",
      tradeThesisTag: "Development Fallback",
      entryMarketRegime: "Rule-based"
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

export async function reconcilePendingFills(gateway: BrokerGateway, accountNumber: string, userId: string = "local"): Promise<void> {
  const pending = listFillEvents(accountNumber, "live", 500, userId).filter(
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
        }, userId);
        
        audit("fill_reconciled", {
          fillId: fill.id,
          symbol: fill.symbol,
          status: "filled",
          price,
          quantity: qty
        }, userId);
      } else if (["cancelled", "rejected", "failed"].includes(matched.state)) {
        updateFillEvent(fill.id, {
          status: matched.state,
          raw: {
            ...((fill.raw as Record<string, unknown>) ?? {}),
            reconciliation: matched
          }
        }, userId);
        
        audit("fill_reconciled", {
          fillId: fill.id,
          symbol: fill.symbol,
          status: matched.state
        }, userId);
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
