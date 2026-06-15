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
  livePortfolio?: Portfolio;
  livePositions?: EquityPosition[];
  paperPortfolio?: Portfolio;
  paperPositions?: EquityPosition[];
  orders: EquityOrder[];
  audit: AuditEvent[];
  latestStrategyRun?: StrategyDecision;
  dailyStats: { orderCount: number; notional: number };
  strategyRuns: StrategyRunRow[];
  pendingProposals: PendingProposal[];
  scheduler?: { lastRunAt: string | null; nextRunAt: string | null; runsToday?: number };
  marketSession?: string;
  performance?: PerformanceSummary;
  profiles: StrategyProfile[];
  activeProfile?: StrategyProfile;
  notifications: NotificationEvent[];
  notificationStatus: {
    configured: boolean;
    enabledEvents: string[];
  };
}
