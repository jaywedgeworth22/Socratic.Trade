import type {
  BrokerageAccount,
  EquityOrder,
  EquityPosition,
  MarketScan,
  NotificationEvent,
  PendingProposal,
  PerformanceSummary,
  Portfolio,
  StrategyProfile,
  StrategyRunRow,
  TradingPolicy,
  TradeProposal,
  ConnectedAccount
} from "@/lib/types";
import type { RegimeStat, ThesisStat } from "@/lib/performance";
import type { TaxSummary } from "@/lib/tax";
import type { MacroData } from "@/lib/macro";
import type { MacroDerivedMetrics } from "@/lib/macro-metrics";
import type { MarketSignals } from "@/lib/market-signals";
import type { AuditFeedItem as DashboardAuditFeedItem, SymbolMeta as DashboardSymbolMeta, UnifiedActivityGroup } from "@/lib/dashboard-feed";
export type { AuditFeedItem, SymbolMeta, UnifiedActivityGroup } from "@/lib/dashboard-feed";

export interface AuditEvent {
  id: string;
  createdAt: string;
  kind: string;
  payload: unknown;
}

export interface StrategyDecision {
  runId: string;
  status: "completed" | "failed";
  summary: string;
  proposals: Array<{ proposal: TradeProposal; status: string; reasons: string[]; orderId?: string }>;
  marketScan?: MarketScan;
}

export interface DashboardSnapshot {
  policy: TradingPolicy;
  strategyPrompt: string;
  accounts: BrokerageAccount[];
  connectedAccounts: ConnectedAccount[];
  portfolio?: Portfolio;
  positions: EquityPosition[];
  symbolMetaBySymbol: Record<string, DashboardSymbolMeta>;
  livePortfolio?: Portfolio;
  livePositions?: EquityPosition[];
  paperPortfolio?: Portfolio;
  paperPositions?: EquityPosition[];
  orders: EquityOrder[];
  audit: AuditEvent[];
  auditFeed: DashboardAuditFeedItem[];
  unifiedFeed: UnifiedActivityGroup[];
  latestStrategyRun?: StrategyDecision;
  dailyStats: { orderCount: number; notional: number };
  strategyRuns: StrategyRunRow[];
  pendingProposals: PendingProposal[];
  scheduler?: { lastRunAt: string | null; nextRunAt: string | null; runsToday?: number };
  webSources?: {
    congress: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number };
    insider: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number };
    finra?: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number; asOf?: string };
    sec8k?: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number };
    technical?: { enabled: boolean; source: "tradingview" | "computed"; fetchedAt?: string; recordCount: number; due: boolean; ttlMs: number; secretConfigured: boolean };
  };
  smartMoney?: {
    congress: Array<{ symbol: string; member: string; chamber: string; side: "buy" | "sell"; amountLow?: number; amountHigh?: number; tradedAt: string; disclosedAt?: string }>;
    insider: Array<{ symbol: string; owner: string; buyTx: number; sellTx: number; filedAt: string }>;
  };
  marketSession?: string;
  /** Backend macro/market-regime board (FRED macro + derived metrics + free market-wide signals). */
  macroBoard?: {
    macro: MacroData;
    derived: MacroDerivedMetrics;
    signals: MarketSignals;
    regime: string;
  };
  performance?: PerformanceSummary;
  thesisScorecard?: ThesisStat[];
  regimeScorecard?: RegimeStat[];
  tax?: TaxSummary;
  profiles: StrategyProfile[];
  activeProfile?: StrategyProfile;
  notifications: NotificationEvent[];
  notificationStatus: {
    configured: boolean;
    enabledEvents: string[];
  };
}
