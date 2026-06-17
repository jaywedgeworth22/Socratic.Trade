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
  TradeProposal
} from "@/lib/types";
import type { RegimeStat, ThesisStat } from "@/lib/performance";
import type { TaxSummary } from "@/lib/tax";
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
  };
  marketSession?: string;
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
