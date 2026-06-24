import {
  dailyExecutionStats,
  getActiveStrategyProfile,
  getPolicy,
  getProposal,
  getStrategyPrompt,
  latestAuditByKind,
  listAudit,
  listNotificationEvents,
  listPendingProposals,
  listRecentProposals,
  listStrategyProfiles,
  listStrategyRuns,
  listFillEvents,
  listConnectedAccounts,
  ensureTestAccount,
  getActiveConnectedAccount
} from "./db";
import { buildAuditFeed, buildSymbolMetaBySymbol, buildUnifiedFeed } from "./dashboard-feed";
import type { StrategyDecisionLike } from "./dashboard-feed";
import { currentMarketSession } from "./market-hours";
import { normalizeSymbol } from "./money";
import { getPaperPortfolioProjection, getPerformanceSummary, getRegimeScorecard, getThesisScorecard, returnSinceProposalPct } from "./performance";
import { computeSpyBenchmark } from "./benchmark";
import { getTaxSummary } from "./tax";
import { getBrokerGateway } from "./broker";
import { deriveExecutionState, fillSourceForExecutionMode } from "./execution-mode";
import { getSchedulerState } from "./scheduler";
import { getCongressDataset, getInsiderDataset, getWebSourcesStatus } from "./web-sources";
import { fetchMacroData, determineMarketRegime } from "./macro";
import { deriveMacroMetrics } from "./macro-metrics";
import { computeMarketInternals } from "./market-internals";
import { getMarketSignals, type MarketSignals } from "./market-signals";
import { fetchMassiveNews } from "./market-signals/massive";
import { fetchMacroHistory } from "./macro-history";
import type { MarketQuote, MarketScan, TradeProposal } from "./types";

export async function getDashboardSnapshot(userId: string = "local", currentUserEmail?: string) {
  ensureTestAccount(userId);
  const policy = getPolicy(userId);
  const gateway = getBrokerGateway(policy, userId);
  let accounts: any[] = [];
  try {
    accounts = await gateway.getAccounts();
  } catch (error) {
    console.warn("Failed to fetch accounts:", error instanceof Error ? error.message : error);
  }
  const accountNumber = policy.accountNumber ?? accounts.find((account) => account.agenticAllowed)?.accountNumber;
  let portfolio, positions: any[] = [], orders: any[] = [];
  if (accountNumber) {
    try {
      [portfolio, positions, orders] = await Promise.all([
        gateway.getPortfolio(accountNumber),
        gateway.getEquityPositions(accountNumber),
        gateway.getEquityOrders(accountNumber)
      ]);
    } catch (error) {
      console.warn("Failed to fetch portfolio:", error instanceof Error ? error.message : error);
    }
  }

  const dailyStats = accountNumber
    ? dailyExecutionStats(accountNumber, new Date(), userId)
    : { orderCount: 0, openingOrderCount: 0, notional: 0 };

  // Build a live current-price map (broker quotes for held + paper symbols) so the paper
  // account and all P&L are marked to the same prices Live uses.
  let currentPrices: Record<string, number> = {};
  let paperProjection: ReturnType<typeof getPaperPortfolioProjection> | undefined;
  if (accountNumber && portfolio) {
    const paperPre = getPaperPortfolioProjection({ accountNumber, startingCash: policy.paperStartingCash, userId });
    const priceSymbols = Array.from(
      new Set([...positions.map((p) => normalizeSymbol(p.symbol)), ...paperPre.positions.map((p) => normalizeSymbol(p.symbol))])
    );
    const quotes = priceSymbols.length > 0 ? await gateway.getEquityQuotes(accountNumber, priceSymbols) : {};
    currentPrices = Object.fromEntries(
      Object.values(quotes)
        .filter((quote) => typeof quote.price === "number" && quote.price > 0)
        .map((quote) => [normalizeSymbol(quote.symbol), quote.price as number] as const)
    );
    // Fall back to the live position's mark when a broker quote is missing.
    for (const position of positions) {
      const symbol = normalizeSymbol(position.symbol);
      if (!(symbol in currentPrices) && position.quantity > 0) currentPrices[symbol] = position.marketValue / position.quantity;
    }
    paperProjection = getPaperPortfolioProjection({ accountNumber, startingCash: policy.paperStartingCash, currentPrices, userId });
  }
  const displayPortfolio = policy.paperMode ? paperProjection?.portfolio ?? portfolio : portfolio;
  const displayPositions = policy.paperMode ? paperProjection?.positions ?? positions : positions;

  const pendingProposals = accountNumber ? listPendingProposals(accountNumber, userId) : [];
  const recentProposals = accountNumber ? listRecentProposals(accountNumber, 100, userId) : [];
  const performance = accountNumber ? getPerformanceSummary(accountNumber, currentPrices, userId) : undefined;
  const activeAccountForTax = getActiveConnectedAccount(userId);
  const executionState = deriveExecutionState(policy, activeAccountForTax);
  const scorecardSource = fillSourceForExecutionMode(executionState);
  // SPY-benchmark scoreboard for the active execution mode's equity curve. Best-effort: a SPY fetch
  // failure or sparse history simply leaves performance.benchmark undefined (UI shows "—").
  if (performance) {
    const curve = scorecardSource === "live" ? performance.liveEquityCurve : performance.paperEquityCurve;
    const benchmark = await computeSpyBenchmark(curve, userId).catch(() => null);
    if (benchmark) performance.benchmark = benchmark;
  }
  const thesisScorecard = accountNumber ? getThesisScorecard(accountNumber, scorecardSource, currentPrices, userId) : [];
  const regimeScorecard = accountNumber ? getRegimeScorecard(accountNumber, scorecardSource, currentPrices, userId) : [];
  const tax = accountNumber
    ? getTaxSummary(accountNumber, scorecardSource, currentPrices, { ...policy.taxSettings, taxationType: activeAccountForTax?.taxationType ?? policy.taxSettings?.taxationType }, new Date(), userId)
    : undefined;
  const profiles = listStrategyProfiles(userId);
  const activeProfile = getActiveStrategyProfile(userId);
  const notifications = listNotificationEvents(userId, 50);
  const latestRunAudit = latestAuditByKind("strategy_run", userId);
  const latestStrategyRun = latestRunAudit
    ? ({ ...(latestRunAudit.payload as StrategyDecisionLike), createdAt: latestRunAudit.createdAt } satisfies StrategyDecisionLike)
    : undefined;
  const audit = listAudit(100, userId);
  const symbolMetaBySymbol = buildSymbolMetaBySymbol({
    positions: displayPositions,
    livePositions: positions,
    paperPositions: paperProjection?.positions,
    orders,
    pendingProposals,
    latestStrategyRun
  });
  const auditFeed = buildAuditFeed({
    audit,
    symbolMetaBySymbol,
    getProposalById: (proposalId) => {
      const proposal = getProposal(proposalId, userId);
      return proposal ? { proposal: proposal.proposal } : undefined;
    }
  });

  // Macro & market-regime board for the Macro tab (FRED macro + derived metrics + free
  // market-wide signals). Caches keep this cheap; failures degrade to defaults / omitted.
  const macro = await fetchMacroData(userId);
  // Only compute internals from a full scan. Some historical/trimmed audit shapes only
  // preserve symbol metadata, which is useful for UI labels but not valuation math.
  const scanForInternals = fullMarketScan(latestStrategyRun?.marketScan);
  const marketEarningsYield = scanForInternals
    ? computeMarketInternals(scanForInternals).medianEarnYld
    : undefined;

  // Performance-since-proposal: side-adjusted move from each proposal's referencePrice to the current
  // price. For REJECTED proposals this is the realized counterfactual ("what it did after we passed");
  // for accepted ones, how the entry has fared. Reuses prices already in hand (held-position quotes +
  // the latest scan's quotes), so it's a free read — no new network calls. Degrades to undefined when
  // no anchor or current price is available (UI then shows no badge).
  const scanQuotes = scanForInternals?.quotesBySymbol;
  const proposalCurrentPrice = (symbol: string): number | undefined => {
    const sym = normalizeSymbol(symbol);
    if (typeof currentPrices[sym] === "number" && currentPrices[sym] > 0) return currentPrices[sym];
    const q = scanQuotes?.[sym];
    return q && typeof q.price === "number" && q.price > 0 ? q.price : undefined;
  };
  const withProposalPerf = <T extends { proposal: TradeProposal }>(items: T[]): T[] =>
    items.map((item) => {
      const current = proposalCurrentPrice(item.proposal.symbol);
      const pct = returnSinceProposalPct(item.proposal.referencePrice, current, item.proposal.side);
      if (pct == null) return item;
      return { ...item, performanceSinceProposalPct: pct, proposalReferencePrice: item.proposal.referencePrice, proposalCurrentPrice: current };
    });
  const recentProposalsWithPerf = withProposalPerf(recentProposals);
  const pendingProposalsWithPerf = withProposalPerf(pendingProposals);
  const macroBoard = {
    macro,
    derived: deriveMacroMetrics(macro, { marketEarningsYield }),
    signals: await getMarketSignals(userId).catch((): MarketSignals => ({})),
    regime: determineMarketRegime(macro),
    history: await fetchMacroHistory(Date.now(), userId).catch(() => ({} as Record<string, number[]>)),
    news: await fetchMassiveNews(8, userId).catch(() => [])
  };

  const unifiedFeed = buildUnifiedFeed({
    audit,
    notifications,
    fills: accountNumber ? listFillEvents(accountNumber, undefined, 500, userId) : [],
    orders,
    symbolMetaBySymbol,
    getProposalById: (proposalId) => {
      const proposal = getProposal(proposalId, userId);
      return proposal ? { proposal: proposal.proposal } : undefined;
    }
  });
  const clientAudit = audit.map((event) => ({
    id: event.id,
    createdAt: event.createdAt,
    kind: event.kind,
    payload: null
  }));

  return {
    currentUser: {
      userId,
      ...(currentUserEmail ? { email: currentUserEmail } : {})
    },
    policy,
    strategyPrompt: getStrategyPrompt(userId),
    accounts,
    portfolio: displayPortfolio,
    positions: displayPositions,
    symbolMetaBySymbol,
    livePortfolio: portfolio,
    livePositions: positions,
    paperPortfolio: paperProjection?.portfolio,
    paperPositions: paperProjection?.positions,
    orders,
    audit: clientAudit,
    auditFeed,
    unifiedFeed,
    connectedAccounts: listConnectedAccounts(userId),
    latestStrategyRun,
    dailyStats,
    strategyRuns: listStrategyRuns(15, userId),
    pendingProposals: pendingProposalsWithPerf,
    recentProposals: recentProposalsWithPerf,
    performance,
    thesisScorecard,
    regimeScorecard,
    tax,
    profiles,
    activeProfile,
    notifications,
    notificationStatus: {
      configured: Boolean(policy.notificationSettings.webhookUrl?.trim()),
      enabledEvents: policy.notificationSettings.enabledEvents
    },
    scheduler: getSchedulerState(userId),
    webSources: getWebSourcesStatus(),
    smartMoney: {
      congress: [...(getCongressDataset()?.trades ?? [])]
        .sort((a, b) => (b.tradedAt ?? "").localeCompare(a.tradedAt ?? ""))
        .slice(0, 12),
      insider: [...(getInsiderDataset()?.filings ?? [])]
        .sort((a, b) => (b.filedAt ?? "").localeCompare(a.filedAt ?? ""))
        .slice(0, 8)
    },
    marketSession: currentMarketSession(),
    macroBoard
  };
}

function fullMarketScan(scan: StrategyDecisionLike["marketScan"] | undefined): MarketScan | undefined {
  if (!scan || !Array.isArray(scan.topCandidates) || scan.topCandidates.length === 0) return undefined;
  const first = scan.topCandidates[0] as Partial<MarketQuote>;
  return typeof first.price === "number" && typeof first.intradayChangePct === "number"
    ? (scan as MarketScan)
    : undefined;
}
