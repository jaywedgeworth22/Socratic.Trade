// Backward-compatible type aliases for the old names.
// Prefer importing directly from @jaywedgeworth22/congress-trading-shared going forward.

import type {
  TransactionsPage,
  TransactionsQuery,
  FundamentalRow,
  AnalystRow,
  TickerLeader,
  ClusterBuy,
  MemberLeader,
  MemberPerformance,
  ConvictionTicker,
  BacktestHorizon,
  TickerBacktest,
  CommitteeConflict,
  SecurityRef,
  PriceClose,
  PriceSeries,
  InsiderRow,
  ShortVolumeRow,
  SharePayload,
  CongressEvent,
  CongressEventType,
} from "@jaywedgeworth22/congress-trading-shared";

export type AppATransactionsPage = TransactionsPage;
export type AppATransactionsQuery = TransactionsQuery;
export type AppAFundamental = FundamentalRow;
export type AppAAnalyst = AnalystRow;
export type AppATickerLeader = TickerLeader;
export type AppAClusterRow = ClusterBuy;
export type AppAMemberRow = MemberLeader;
export type AppAMemberPerformance = MemberPerformance;
export type AppAConvictionTicker = ConvictionTicker;
export type AppABacktestHorizon = BacktestHorizon;
export type AppATickerBacktest = TickerBacktest;
export type AppAConflict = CommitteeConflict;
export type CongressRef = SecurityRef;
export type CongressClose = PriceClose;
export type CongressPrice = PriceSeries;
export type CongressInsider = InsiderRow;
export type CongressShortVol = ShortVolumeRow;
export type CongressFundamental = FundamentalRow;
export type CongressAnalyst = AnalystRow;
export type CongressSharePayload = SharePayload;
export type CongressEventFromShared = CongressEvent;
export type CongressEventTypeFromShared = CongressEventType;
