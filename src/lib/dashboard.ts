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
  listStrategyProfiles,
  listStrategyRuns,
  listFillEvents
} from "./db";
import { buildAuditFeed, buildSymbolMetaBySymbol, buildUnifiedFeed } from "./dashboard-feed";
import type { StrategyDecisionLike } from "./dashboard-feed";
import { currentMarketSession } from "./market-hours";
import { normalizeSymbol } from "./money";
import { getPaperPortfolioProjection, getPerformanceSummary, getRegimeScorecard, getThesisScorecard } from "./performance";
import { getRobinhoodGateway } from "./robinhood";
import { getSchedulerState } from "./scheduler";

export async function getDashboardSnapshot() {
  const gateway = getRobinhoodGateway();
  const policy = getPolicy();
  const accounts = await gateway.getAccounts();
  const accountNumber = policy.accountNumber ?? accounts.find((account) => account.agenticAllowed)?.accountNumber;
  const [portfolio, positions, orders] = accountNumber
    ? await Promise.all([
        gateway.getPortfolio(accountNumber),
        gateway.getEquityPositions(accountNumber),
        gateway.getEquityOrders(accountNumber)
      ])
    : [undefined, [], []];

  const dailyStats = accountNumber
    ? dailyExecutionStats(accountNumber)
    : { orderCount: 0, notional: 0 };

  // Build a live current-price map (broker quotes for held + paper symbols) so the paper
  // account and all P&L are marked to the same prices Live uses.
  let currentPrices: Record<string, number> = {};
  let paperProjection: ReturnType<typeof getPaperPortfolioProjection> | undefined;
  if (accountNumber && portfolio) {
    const paperPre = getPaperPortfolioProjection({ accountNumber, startingCash: policy.paperStartingCash });
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
    paperProjection = getPaperPortfolioProjection({ accountNumber, startingCash: policy.paperStartingCash, currentPrices });
  }
  const displayPortfolio = policy.paperMode ? paperProjection?.portfolio ?? portfolio : portfolio;
  const displayPositions = policy.paperMode ? paperProjection?.positions ?? positions : positions;

  const pendingProposals = accountNumber ? listPendingProposals(accountNumber) : [];
  const performance = accountNumber ? getPerformanceSummary(accountNumber, currentPrices) : undefined;
  const scorecardSource = policy.paperMode ? "paper" : "live";
  const thesisScorecard = accountNumber ? getThesisScorecard(accountNumber, scorecardSource, currentPrices) : [];
  const regimeScorecard = accountNumber ? getRegimeScorecard(accountNumber, scorecardSource, currentPrices) : [];
  const profiles = listStrategyProfiles();
  const activeProfile = getActiveStrategyProfile();
  const notifications = listNotificationEvents(50);
  const latestStrategyRun = latestAuditByKind("strategy_run")?.payload as StrategyDecisionLike | undefined;
  const audit = listAudit(100);
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
      const proposal = getProposal(proposalId);
      return proposal ? { proposal: proposal.proposal } : undefined;
    }
  });

  const unifiedFeed = buildUnifiedFeed({
    audit,
    notifications,
    fills: accountNumber ? listFillEvents(accountNumber) : [],
    orders,
    symbolMetaBySymbol,
    getProposalById: (proposalId) => {
      const proposal = getProposal(proposalId);
      return proposal ? { proposal: proposal.proposal } : undefined;
    }
  });

  return {
    policy,
    strategyPrompt: getStrategyPrompt(),
    accounts,
    portfolio: displayPortfolio,
    positions: displayPositions,
    symbolMetaBySymbol,
    livePortfolio: portfolio,
    livePositions: positions,
    paperPortfolio: paperProjection?.portfolio,
    paperPositions: paperProjection?.positions,
    orders,
    audit,
    auditFeed,
    unifiedFeed,
    latestStrategyRun,
    dailyStats,
    strategyRuns: listStrategyRuns(15),
    pendingProposals,
    performance,
    thesisScorecard,
    regimeScorecard,
    profiles,
    activeProfile,
    notifications,
    notificationStatus: {
      configured: Boolean(policy.notificationSettings.webhookUrl?.trim()),
      enabledEvents: policy.notificationSettings.enabledEvents
    },
    scheduler: getSchedulerState(),
    marketSession: currentMarketSession()
  };
}
