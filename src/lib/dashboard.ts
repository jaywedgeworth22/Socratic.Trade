import {
  dailyExecutionStats,
  getActiveStrategyProfile,
  getAutoResumeOnBoot,
  getPolicy,
  getProposalsByIds,
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
  getActiveConnectedAccount,
  userHasAnyLlmCredential
} from "./db";
import { buildAuditFeed, buildSymbolMetaBySymbol, buildUnifiedFeed } from "./dashboard-feed";
import type { StrategyDecisionLike } from "./dashboard-feed";
import { currentMarketSession } from "./market-hours";
import { normalizeSymbol } from "./money";
import { getPaperPortfolioProjection, getPerformanceSummary, getRegimeScorecard, getThesisScorecard, returnSinceProposalPct } from "./performance";
import { computeSpyBenchmark } from "./benchmark";
import { getTaxSummary } from "./tax";
import { getBrokerGateway } from "./broker";
import { getRobinhoodMcpHealth, type RobinhoodMcpHealth } from "./robinhood";
import { getStoredMcpOAuthTokens } from "./mcp-oauth";
import { deriveExecutionState, fillSourceForExecutionMode } from "./execution-mode";
import { getSchedulerState } from "./scheduler";
import { getCongressDataset, getInsiderDataset, getWebSourcesStatus } from "./web-sources";
import { fetchMacroData, determineMarketRegime } from "./macro";
import { deriveMacroMetrics } from "./macro-metrics";
import { computeMarketInternals } from "./market-internals";
import { getMarketSignals, type MarketSignals } from "./market-signals";
import { fetchMassiveNews } from "./market-signals/massive";
import { fetchMacroHistory } from "./macro-history";
import type { PrefetchedFills } from "./performance";
import type { BrokerageAccount, ConnectedAccount, EquityOrder, EquityPosition, FillEvent, MarketQuote, MarketScan, Portfolio, TradeProposal, TradingPolicy } from "./types";
import { isAdminEmail } from "./auth/admin";
import { messageFromUnknownError, recordRecoverableIssue } from "./recoverable-issue";

const PROPOSAL_PERFORMANCE_MIN_AGE_MS = 15 * 60_000;

export interface AccountReadiness {
  ok: boolean;
  reason?: string;
  detail: string;
  accountNumber?: string;
  connectedAccountId?: string;
  broker?: TradingPolicy["activeBroker"] | ConnectedAccount["broker"];
}

/**
 * Derive agentic-allowed for a STORED connected account, used as a fallback when the live broker
 * enumeration is unavailable. Mirrors the live gateways: Robinhood defaults agentic-allowed only for a
 * standard brokerage account (not IRA/Roth); Alpaca and the local Test gateway report agentic-allowed
 * for all of their accounts. Exported for unit testing.
 */
export function connectedAccountAgenticFallback(account: {
  broker: string;
  capabilities?: { accountType?: string };
}): boolean {
  if (account.broker === "robinhood") {
    return (account.capabilities?.accountType ?? "brokerage") === "brokerage";
  }
  return true; // alpaca / alpaca-mcp / test gateways report agentic-allowed for all their accounts
}

function brokerDisplayName(broker: AccountReadiness["broker"] | undefined): string {
  switch (broker) {
    case "alpaca":
    case "alpaca-mcp":
      return "Alpaca";
    case "robinhood":
      return "Robinhood";
    case "test":
      return "Test";
    default:
      return "broker";
  }
}

function robinhoodMcpHealthIssue(health: RobinhoodMcpHealth | undefined): string | undefined {
  if (!health) return undefined;
  if (health.ok && health.configured && health.authenticated) return undefined;
  return health.error ?? health.warning ?? "Robinhood OAuth is not connected.";
}

export function accountReadinessForSnapshot(input: {
  policy: TradingPolicy;
  activeAccount?: ConnectedAccount;
  liveAccounts: BrokerageAccount[];
  brokerAccountReadError?: string;
  portfolioReadError?: string;
  robinhoodMcpHealth?: RobinhoodMcpHealth;
}): AccountReadiness {
  const { policy, activeAccount } = input;
  const accountNumber = policy.accountNumber ?? activeAccount?.accountNumber;
  const broker = activeAccount?.broker ?? policy.activeBroker;
  const brokerName = brokerDisplayName(broker);
  const isLocalTestMode = policy.paperMode || broker === "test";

  if (!accountNumber) {
    return {
      ok: false,
      reason: "Select an account before enabling autonomy.",
      detail: "No account is selected.",
      connectedAccountId: policy.connectedAccountId,
      broker
    };
  }

  if (policy.connectedAccountId && !activeAccount) {
    return {
      ok: false,
      reason: "Open Accounts and choose a working account before enabling autonomy.",
      detail: `Selected connected account ${policy.connectedAccountId} was not found.`,
      accountNumber,
      connectedAccountId: policy.connectedAccountId,
      broker
    };
  }

  const robinhoodIssue = !isLocalTestMode && broker === "robinhood" ? robinhoodMcpHealthIssue(input.robinhoodMcpHealth) : undefined;
  if (robinhoodIssue) {
    return {
      ok: false,
      reason: "Reconnect Robinhood OAuth before enabling autonomy.",
      detail: robinhoodIssue,
      accountNumber,
      connectedAccountId: activeAccount?.id ?? policy.connectedAccountId,
      broker
    };
  }

  const requiresBrokerReadiness = !isLocalTestMode;
  if (requiresBrokerReadiness) {
    if (input.brokerAccountReadError) {
      return {
        ok: false,
        reason: `${brokerName} account check failed. Open Accounts and reconnect or fix credentials.`,
        detail: input.brokerAccountReadError,
        accountNumber,
        connectedAccountId: activeAccount?.id ?? policy.connectedAccountId,
        broker
      };
    }

    const liveAccount = input.liveAccounts.find((account) => account.accountNumber === accountNumber);
    if (!liveAccount) {
      return {
        ok: false,
        reason: `Selected ${brokerName} account is not available from the broker.`,
        detail: `The selected account ${accountNumber} was not returned by ${brokerName}.`,
        accountNumber,
        connectedAccountId: activeAccount?.id ?? policy.connectedAccountId,
        broker
      };
    }

    if (!liveAccount.agenticAllowed) {
      return {
        ok: false,
        reason: `Selected ${brokerName} account is not approved for agentic execution.`,
        detail: `${brokerName} returned account ${accountNumber}, but marked it not agentic-allowed.`,
        accountNumber,
        connectedAccountId: activeAccount?.id ?? policy.connectedAccountId,
        broker
      };
    }
  }

  if (isLocalTestMode) {
    return {
      ok: true,
      detail: `Selected Test account ${accountNumber}.`,
      accountNumber,
      connectedAccountId: activeAccount?.id ?? policy.connectedAccountId,
      broker
    };
  }

  if (input.portfolioReadError) {
    return {
      ok: false,
      reason: `${brokerName} account data check failed. Open Accounts and reconnect or fix credentials.`,
      detail: input.portfolioReadError,
      accountNumber,
      connectedAccountId: activeAccount?.id ?? policy.connectedAccountId,
      broker
    };
  }

  return {
    ok: true,
    detail: isLocalTestMode
      ? `Selected Test account ${accountNumber}.`
      : `Selected ${brokerName} account ${accountNumber} is available for execution.`,
    accountNumber,
    connectedAccountId: activeAccount?.id ?? policy.connectedAccountId,
    broker
  };
}

export interface CurrentUserDisplay {
  email?: string;
  name?: string;
  imageUrl?: string;
  loginProvider?: string;
}

export async function getDashboardSnapshot(userId: string = "local", currentUser?: string | CurrentUserDisplay) {
  const currentUserDisplay: CurrentUserDisplay =
    typeof currentUser === "string" ? { email: currentUser } : currentUser ?? {};
  ensureTestAccount(userId);
  const policy = getPolicy(userId);
  const activeAccount = getActiveConnectedAccount(userId);
  const connectedAccounts = listConnectedAccounts(userId);
  const accountLabelById = Object.fromEntries(connectedAccounts.map((account) => [account.id, account.label || account.broker]));
  const gateway = getBrokerGateway(policy, userId);
  let accounts: BrokerageAccount[] = [];
  let brokerAccountReadError: string | undefined;
  try {
    accounts = await gateway.getAccounts();
  } catch (error) {
    const message = messageFromUnknownError(error);
    brokerAccountReadError = message;
    console.warn("Failed to fetch accounts:", message);
    recordRecoverableIssue({
      source: "broker",
      operation: "dashboard.getAccounts",
      severity: "error",
      message,
      fallback: "Using stored connected-account rows so configured accounts remain visible.",
      userId,
      connectedAccountId: policy.connectedAccountId,
      broker: policy.activeBroker,
      accountNumber: policy.accountNumber
    });
  }
  // Resilience: a live getAccounts() that fails or returns empty (a transient broker/MCP enumeration
  // miss) must not make the configured account vanish from the snapshot — which made the readiness
  // badge false-warn "not available for agentic execution". Backfill any stored connected account the
  // live list didn't return, deriving agenticAllowed from the account type so the selected account
  // always resolves to a definitive status.
  const liveAccounts = accounts.slice();
  const liveAccountNumbers = new Set(liveAccounts.map((account) => account.accountNumber));
  let storedBackfillCount = 0;
  let selectedAccountWasBackfilled = false;
  for (const connected of connectedAccounts) {
    if (!connected.accountNumber || liveAccountNumbers.has(connected.accountNumber)) continue;
    storedBackfillCount += 1;
    if (connected.id === policy.connectedAccountId || connected.accountNumber === policy.accountNumber) {
      selectedAccountWasBackfilled = true;
    }
    accounts.push({
      accountNumber: connected.accountNumber,
      label: connected.label,
      agenticAllowed: connectedAccountAgenticFallback(connected),
      capabilities: connected.capabilities
    });
  }
  if (storedBackfillCount > 0 && (brokerAccountReadError || selectedAccountWasBackfilled)) {
    recordRecoverableIssue({
      source: "broker",
      operation: "dashboard.connectedAccountBackfill",
      message: brokerAccountReadError
        ? "Live broker account enumeration failed, so the dashboard used stored connected-account metadata."
        : "Live broker account enumeration did not include the selected account.",
      fallback: "Stored connected-account rows were added to the dashboard snapshot.",
      userId,
      connectedAccountId: policy.connectedAccountId,
      broker: policy.activeBroker,
      accountNumber: policy.accountNumber,
      details: { backfilledAccounts: storedBackfillCount, brokerAccountReadFailed: Boolean(brokerAccountReadError), selectedAccountWasBackfilled }
    });
  }
  let robinhoodMcpHealth: RobinhoodMcpHealth | undefined;
  if ((activeAccount?.broker ?? policy.activeBroker) === "robinhood") {
    robinhoodMcpHealth = await getRobinhoodMcpHealth(userId).catch((error): RobinhoodMcpHealth => ({
      adapter: "mcp",
      ok: false,
      configured: false,
      authenticated: false,
      protocolVersion: "",
      transport: "http+sse",
      tools: [],
      checkedAt: new Date().toISOString(),
      error: messageFromUnknownError(error)
    }));
  }
  const accountNumber = policy.accountNumber ?? accounts.find((account) => account.agenticAllowed)?.accountNumber;
  let portfolio: Portfolio | undefined;
  let positions: EquityPosition[] = [];
  let orders: EquityOrder[] = [];
  let portfolioReadError: string | undefined;
  if (accountNumber) {
    try {
      [portfolio, positions, orders] = await Promise.all([
        gateway.getPortfolio(accountNumber),
        gateway.getEquityPositions(accountNumber),
        gateway.getEquityOrders(accountNumber)
      ]);
    } catch (error) {
      const message = messageFromUnknownError(error);
      portfolioReadError = message;
      console.warn("Failed to fetch portfolio:", message);
      recordRecoverableIssue({
        source: "broker",
        operation: "dashboard.getPortfolioBundle",
        severity: "error",
        message,
        fallback: "Dashboard snapshot continues without live portfolio, positions, and orders.",
        userId,
        connectedAccountId: policy.connectedAccountId,
        broker: policy.activeBroker,
        accountNumber
      });
    }
  }
  const accountReadiness = accountReadinessForSnapshot({
    policy,
    activeAccount,
    liveAccounts,
    brokerAccountReadError,
    portfolioReadError,
    robinhoodMcpHealth
  });

  const dailyStats = accountNumber
    ? dailyExecutionStats(accountNumber, new Date(), userId)
    : { orderCount: 0, openingOrderCount: 0, notional: 0 };

  // Fetch live + paper fills ONCE per request (each is a 500-row SELECT + JSON.parse + FIFO replay)
  // and thread the parsed arrays into every downstream consumer — performance summary, scorecards,
  // tax, the paper projection, and the unified feed — instead of each re-issuing its own query.
  const liveFills: FillEvent[] = accountNumber ? listFillEvents(accountNumber, "live", 500, userId) : [];
  const paperFills: FillEvent[] = accountNumber ? listFillEvents(accountNumber, "paper", 500, userId) : [];
  const prefetchedFills: PrefetchedFills = { liveFills, paperFills };

  // Build a live current-price map (broker quotes for held + paper symbols) so the paper
  // account and all P&L are marked to the same prices Live uses.
  let currentPrices: Record<string, number> = {};
  let paperProjection: ReturnType<typeof getPaperPortfolioProjection> | undefined;
  if (accountNumber && portfolio) {
    // Single projection replay (reuses the pre-fetched paper fills). We derive the price symbols
    // from its open positions, fetch quotes, then re-mark the SAME positions to those prices in
    // place — collapsing the old two back-to-back getPaperPortfolioProjection calls into one.
    const projection = getPaperPortfolioProjection({ accountNumber, startingCash: policy.paperStartingCash, userId, paperFills });
    const priceSymbols = Array.from(
      new Set([...positions.map((p) => normalizeSymbol(p.symbol)), ...projection.positions.map((p) => normalizeSymbol(p.symbol))])
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
    // Re-mark the already-replayed positions to the resolved prices (fall back to averageCost when a
    // price is missing) — identical math to a fresh getPaperPortfolioProjection({ currentPrices }),
    // but without a second fill replay.
    const remarkedPositions = projection.positions.map((position) => {
      const mark = currentPrices[normalizeSymbol(position.symbol)] ?? position.averageCost;
      return { ...position, marketValue: position.quantity * mark };
    });
    const equityMarketValue = remarkedPositions.reduce((sum, position) => sum + position.marketValue, 0);
    paperProjection = {
      positions: remarkedPositions,
      portfolio: {
        ...projection.portfolio,
        equityMarketValue,
        totalMarketValue: projection.portfolio.cash + equityMarketValue
      }
    };
  }
  const displayPortfolio = policy.paperMode ? paperProjection?.portfolio ?? portfolio : portfolio;
  const displayPositions = policy.paperMode ? paperProjection?.positions ?? positions : positions;

  const pendingProposals = accountNumber ? listPendingProposals(accountNumber, userId) : [];
  const recentProposals = accountNumber ? listRecentProposals(accountNumber, 100, userId) : [];
  const performance = accountNumber ? getPerformanceSummary(accountNumber, currentPrices, userId, prefetchedFills) : undefined;
  const executionState = deriveExecutionState(policy, activeAccount);
  const scorecardSource = fillSourceForExecutionMode(executionState);
  // SPY-benchmark scoreboard for the active execution mode's equity curve. Best-effort: a SPY fetch
  // failure or sparse history simply leaves performance.benchmark undefined (UI shows "—").
  if (performance) {
    const curve = scorecardSource === "live" ? performance.liveEquityCurve : performance.paperEquityCurve;
    const benchmark = await computeSpyBenchmark(curve, userId).catch(() => null);
    if (benchmark) performance.benchmark = benchmark;
  }
  const thesisScorecard = accountNumber ? getThesisScorecard(accountNumber, scorecardSource, currentPrices, userId, prefetchedFills) : [];
  const regimeScorecard = accountNumber ? getRegimeScorecard(accountNumber, scorecardSource, currentPrices, userId, prefetchedFills) : [];
  const tax = accountNumber
    ? getTaxSummary(accountNumber, scorecardSource, currentPrices, { ...policy.taxSettings, taxationType: activeAccount?.taxationType ?? policy.taxSettings?.taxationType }, new Date(), userId, prefetchedFills)
    : undefined;
  const profiles = listStrategyProfiles(userId);
  const activeProfile = getActiveStrategyProfile(userId);
  const notifications = listNotificationEvents(userId, 50);
  const latestRunAudit = policy.connectedAccountId
    ? latestAuditByKind("strategy_run", userId, policy.connectedAccountId)
    : latestAuditByKind("strategy_run", userId);
  const latestStrategyRun = latestRunAudit
    ? ({ ...(latestRunAudit.payload as StrategyDecisionLike), createdAt: latestRunAudit.createdAt } satisfies StrategyDecisionLike)
    : undefined;
  const audit = policy.connectedAccountId
    ? listAudit(100, userId, policy.connectedAccountId, true)
    : listAudit(100, userId);

  // Unified fills for the feed: merge the pre-fetched live + paper arrays (oldest-first, capped at
  // 500) instead of re-issuing the unfiltered listFillEvents query the feed builder used to trigger.
  const unifiedFills: FillEvent[] = accountNumber
    ? [...liveFills, ...paperFills].sort((a, b) => a.filledAt.localeCompare(b.filledAt)).slice(0, 500)
    : [];

  // Batch every proposal point-query the audit/unified-feed builders would otherwise issue one-by-one:
  // collect all distinct proposalIds referenced by audit rows, fills, and notifications, run ONE
  // `WHERE id IN (...)` query, and back a Map-keyed closure with it (with a memoized single-row
  // fallback for any id not pre-collected, so output is identical to the old per-row getProposal).
  const referencedProposalIds = new Set<string>();
  const addProposalId = (value: unknown) => {
    if (typeof value === "string" && value) referencedProposalIds.add(value);
  };
  const asRec = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  for (const event of audit) {
    const payload = asRec(event.payload);
    const nested = asRec(payload.payload);
    addProposalId(payload.proposalId);
    addProposalId(nested.proposalId);
    addProposalId(asRec(nested.proposal).id);
    addProposalId(asRec(nested.proposal).proposalId);
    addProposalId(asRec(nested.fill).proposalId);
  }
  for (const fill of unifiedFills) addProposalId(fill.proposalId);
  for (const notification of notifications) {
    const payload = asRec(notification.payload);
    addProposalId(payload.proposalId);
    addProposalId(asRec(payload.fill).proposalId);
    addProposalId(asRec(payload.proposal).id);
    addProposalId(asRec(payload.proposal).proposalId);
  }
  const proposalsById = getProposalsByIds([...referencedProposalIds], userId);
  const proposalFallbackCache = new Map<string, { proposal: TradeProposal } | undefined>();
  const getProposalById = (proposalId: string): { proposal: TradeProposal } | undefined => {
    const batched = proposalsById.get(proposalId);
    if (batched) return { proposal: batched.proposal };
    if (proposalFallbackCache.has(proposalId)) return proposalFallbackCache.get(proposalId);
    const single = getProposalsByIds([proposalId], userId).get(proposalId);
    const resolved = single ? { proposal: single.proposal } : undefined;
    proposalFallbackCache.set(proposalId, resolved);
    return resolved;
  };

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
    accountLabelById,
    getProposalById
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
  // the latest scan's quotes), so it's a free read — no new network calls. Fresh proposals are
  // intentionally left blank: delayed/intraday quote sources can otherwise show noisy "since" moves
  // seconds after creation. Degrades to undefined when no anchor or current price is available.
  const scanQuotes = scanForInternals?.quotesBySymbol;
  const proposalCurrentPrice = (symbol: string): number | undefined => {
    const sym = normalizeSymbol(symbol);
    if (typeof currentPrices[sym] === "number" && currentPrices[sym] > 0) return currentPrices[sym];
    const q = scanQuotes?.[sym];
    return q && typeof q.price === "number" && q.price > 0 ? q.price : undefined;
  };
  const proposalIsOldEnoughForPerformance = (createdAt?: string): boolean => {
    if (!createdAt) return true;
    const createdMs = Date.parse(createdAt);
    if (!Number.isFinite(createdMs)) return true;
    return Date.now() - createdMs >= PROPOSAL_PERFORMANCE_MIN_AGE_MS;
  };
  const withProposalPerf = <T extends { proposal: TradeProposal; createdAt?: string }>(items: T[]): T[] =>
    items.map((item) => {
      if (!proposalIsOldEnoughForPerformance(item.createdAt)) return item;
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
    fills: unifiedFills,
    orders,
    symbolMetaBySymbol,
    accountLabelById,
    getProposalById
  });
  const clientAudit = audit.map((event) => ({
    id: event.id,
    createdAt: event.createdAt,
    kind: event.kind,
    payload: null,
    connectedAccountId: event.connectedAccountId
  }));

  return {
    currentUser: {
      userId,
      ...(currentUserDisplay.email ? { email: currentUserDisplay.email } : {}),
      ...(currentUserDisplay.name ? { name: currentUserDisplay.name } : {}),
      ...(currentUserDisplay.imageUrl ? { imageUrl: currentUserDisplay.imageUrl } : {}),
      ...(currentUserDisplay.loginProvider ? { loginProvider: currentUserDisplay.loginProvider } : {}),
      isAdmin: isAdminEmail(currentUserDisplay.email)
    },
    // Whether at least one LLM provider has a resolvable credential for this user (own key OR operator
    // failover). The two LLM-driven actions (Run once / chat) are gated on this; everything else works
    // keyless. The client uses it to disable "Run once" with an actionable message before the 412.
    llmConfigured: userHasAnyLlmCredential(userId),
    policy,
    strategyPrompt: getStrategyPrompt(userId),
    accounts,
    accountReadiness,
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
    connectedAccounts,
    latestStrategyRun,
    dailyStats,
    strategyRuns: listStrategyRuns(15, userId, policy.connectedAccountId),
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
    robinhoodMcpConnected: policy.activeBroker === "robinhood" ? Boolean(getStoredMcpOAuthTokens(userId)) : true,
    autoResumeOnBoot: getAutoResumeOnBoot(userId),
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
