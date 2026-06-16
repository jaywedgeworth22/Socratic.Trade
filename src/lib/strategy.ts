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
import { fetchMacroData } from "./macro";
import { normalizeSymbol } from "./money";
import { sendNotification } from "./notifications";
import { getPaperPortfolioProjection, recordFillFromProposal, recordPortfolioSnapshot } from "./performance";
import { allowedSymbolsForPolicy, evaluateTradeProposal } from "./policy";
import { getRobinhoodGateway, type RobinhoodGateway } from "./robinhood";
import type { EquityPosition, MarketScan, Portfolio, TradingPolicy, TradeProposal } from "./types";

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

    // In Paper mode, decisions run against the standalone paper account (starting cash +
    // prior paper fills, marked to live prices) so the simulation evolves like Live.
    const currentPrices = currentPricesFromScan(marketScan);
    const account = policy.paperMode
      ? getPaperPortfolioProjection({ accountNumber: policy.accountNumber, startingCash: policy.paperStartingCash, currentPrices })
      : { portfolio, positions };
    const workingPortfolio = account.portfolio;
    const workingPositions = account.positions;

    const proactiveProposals = generateProactiveRiskProposals(workingPositions, currentPrices, policy);

    const proposals = [
      ...proactiveProposals,
      ...(await proposeTrades({
        policyAllowlist: allowedSymbols,
        prompt: getStrategyPrompt(),
        policy,
        portfolio: workingPortfolio,
        positions: workingPositions,
        recentOrders: orders.slice(0, 20),
        marketScan,
        dailyNotionalUsed: daily.notional,
        dailyOrderCount: daily.orderCount
      }))
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
          { type: "block", title: `${normalizedProposal.symbol} blocked`, payload: { runId, proposalId, decision } },
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
        marketScan
      });

      if (!decision.approved) {
        const proposalId = crypto.randomUUID();
        insertProposal({ id: proposalId, runId, accountNumber: policy.accountNumber, proposal: normalizedProposal, decision, review, estimatedNotional: review.estimatedNotional, status: "blocked" });
        await sendNotification(
          { type: "block", title: `${normalizedProposal.symbol} blocked`, payload: { runId, proposalId, decision, review } },
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
          { type: "fill", title: `${normalizedProposal.symbol} Paper fill`, payload: { runId, proposalId, fill } },
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
    audit("proposal_approved", { proposalId, result: "blocked", reason });
    await sendNotification({ type: "block", title: `${proposal.symbol} approval blocked`, payload: { proposalId, reason } }, { policy });
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
    marketScan: approvalScan
  });

  if (!decision.approved) {
    updateProposalStatus(proposalId, "blocked", undefined, review, review.estimatedNotional);
    audit("proposal_approved", { proposalId, result: "blocked", reasons: decision.reasons });
    await sendNotification({ type: "block", title: `${proposal.symbol} approval blocked`, payload: { proposalId, decision, review } }, { policy });
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
    audit("proposal_approved", { proposalId, result: "paper" });
    await sendNotification({ type: "fill", title: `${proposal.symbol} Paper approval fill`, payload: { proposalId, fill } }, { policy });
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
  audit("proposal_approved", { proposalId, result: "placed", orderId: execution.orderId });
  await sendNotification({ type: "fill", title: `${proposal.symbol} approval order ${execution.state}`, payload: { proposalId, fill } }, { policy });
  return { status: "placed", orderId: execution.orderId };
}

export function rejectProposal(proposalId: string): void {
  updateProposalStatus(proposalId, "rejected");
  audit("proposal_rejected", { proposalId });
}

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

  const systemPrompt = [
    "You are an autonomous equity trading agent for a Robinhood brokerage account.",
    "",
    "Investment Strategy:",
    input.prompt,
    "",
    `When to SELL/TRIM: any position exceeding ${input.policy.maxSymbolExposurePct}% of portfolio value;`,
    `positions down more than ${input.policy.riskRules.stopLossPct ?? 8}% without a clear catalyst;`,
    `positions up more than ${input.policy.riskRules.takeProfitPct ?? 20}% where trimming would improve risk/reward; rebalancing toward better-ranked scan opportunities.`,
    "",
    "Return strict JSON only. No markdown. No text outside the JSON object."
  ].join("\n");

  const macro = await fetchMacroData();

  const userContent = {
    currentDate: new Date().toISOString(),
    portfolio: input.portfolio,
    positions: input.positions,
    recentOrders: input.recentOrders,
    allowedSymbols: input.policyAllowlist,
    marketScan: compactMarketScanForPrompt(input.marketScan),
    limits: {
      maxOrderNotional: input.policy.maxOrderNotional,
      remainingDailyNotional: remainingNotional,
      remainingDailyOrders: remainingOrders
    },
    macroeconomicData: macro,
    ...(sectorComposition ? { sectorComposition } : {})
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
            "rationale"
          ],
          properties: {
            symbol: { type: "string" },
            side: { enum: ["buy", "sell"] },
            type: { enum: ["market", "limit", "stop_market", "stop_limit"] },
            quantity: { type: ["number", "null"] },
            dollarAmount: { type: ["number", "null"] },
            limitPrice: { type: ["number", "null"] },
            stopPrice: { type: ["number", "null"] },
            timeInForce: { enum: ["gfd", "gtc"] },
            marketHours: { enum: ["regular_hours", "extended_hours", "all_day_hours"] },
            rationale: { type: "string" }
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
  return sanitizeProposals(JSON.parse(text).proposals ?? [], maxProposals);
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
      sentiment: quote.sentiment,
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
        "Development fallback: OPENAI_API_KEY is not configured, so this is a simple mock rebalance suggestion toward the lowest-exposure allowed holding, not an LLM research recommendation."
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
      marketHours: proposal.marketHours ?? "regular_hours"
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
          rationale: reason
        });
      }
    }
  }
  return proactiveProposals;
}
