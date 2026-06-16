import type { EquityPosition, MarketQuote, NotificationEvent, OrderSide } from "./types";
import type { SymbolMeta } from "./dashboard-feed";
import { formatQuantity } from "./money";

export interface EnrichedPosition extends EquityPosition {
  costBasis: number;
  pnl: number;
  returnPct: number;
  allocPct: number;
}

export interface NotificationDisplayItem {
  title: string;
  detail: string;
  timestamp: string;
  symbol?: string;
  companyName?: string;
}

const SOURCE_LABELS: Record<string, string> = {
  finnhub: "Finnhub",
  fmp: "FMP",
  "yahoo-finance": "Yahoo Finance",
  "nasdaq-delayed-screener": "Nasdaq",
  robinhood: "Robinhood",
  "robinhood-quotes": "Robinhood",
  blended: "blended (multiple sources)"
};

export function enrichPositionsForDisplay(positions: EquityPosition[], totalMarketValue: number): EnrichedPosition[] {
  return positions.map((position) => {
    const costBasis = position.averageCost * position.quantity;
    const pnl = position.marketValue - costBasis;
    return {
      ...position,
      costBasis,
      pnl,
      returnPct: costBasis > 0 ? (pnl / costBasis) * 100 : 0,
      allocPct: totalMarketValue > 0 ? (position.marketValue / totalMarketValue) * 100 : 0
    };
  });
}

export function friendlySource(name?: string): string {
  if (!name) return "unknown";
  return SOURCE_LABELS[name] ?? name;
}

export function companyTitle(symbol: string, symbolMetaBySymbol: Record<string, SymbolMeta>): string | undefined {
  return symbolMetaBySymbol[symbol]?.companyName;
}

export function cellTitle(label: string, source?: string): string {
  return source ? `${label}\nSource: ${friendlySource(source)}` : label;
}

export function quoteTitle(label: string, candidate: MarketQuote): string {
  const source = candidate.provider ? `Source: ${friendlySource(candidate.provider)}` : undefined;
  const asOf = candidate.asOf ? `Quote time: ${new Date(candidate.asOf).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : undefined;
  return [label, source, asOf].filter(Boolean).join("\n");
}

export function ratingTitle(candidate: MarketQuote): string {
  if (typeof candidate.analystScore !== "number") return "No analyst rating data";
  const header = `Blended ${candidate.analystScore}/100 (${candidate.analystRating ?? "n/a"})`;
  const lines = Object.entries(candidate.analystBySource ?? {}).map(([src, detail]) => {
    const suffix = detail.counts
      ? ` (Strong Buy ${detail.counts.strongBuy}, Buy ${detail.counts.buy}, Hold ${detail.counts.hold}, Sell ${detail.counts.sell}, Strong Sell ${detail.counts.strongSell})`
      : typeof detail.mean === "number"
        ? ` (Yahoo mean ${detail.mean}; 1.0 = Strong Buy, 3.0 = Hold, 5.0 = Strong Sell)`
        : "";
    return `${friendlySource(src)}: ${detail.label} ${detail.score}${suffix}`;
  });
  return [header, ...lines].join("\n");
}

export function sentimentTitle(candidate: MarketQuote): string {
  const src = candidate.sources ?? {};
  return typeof candidate.sentiment === "number"
    ? cellTitle(
        `News-tone ${candidate.sentiment}/100 (locally computed from recent Finnhub headlines using keyword scoring)` +
          `\n\nRecent Headlines:\n${candidate.headlines?.map((headline) => `• ${headline}`).join("\n") ?? "None"}`,
        src.sentiment
      )
    : "No recent news";
}

export function scanQuoteAsOf(candidates: MarketQuote[]): string | undefined {
  const timestamp = candidates
    .map((candidate) => candidate.asOf)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  return timestamp ? `quotes as of ${new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : undefined;
}

export function formatShareQuantity(value?: number, symbol?: string): string {
  return formatQuantity(value, symbol);
}

export function formatNotificationDisplay(
  event: NotificationEvent,
  symbolMetaBySymbol: Record<string, SymbolMeta>
): NotificationDisplayItem {
  const payload = asRecord(event.payload);
  const fill = asRecord(payload.fill);
  const proposal = asRecord(payload.proposal);
  const symbol = normalizeSymbol(stringValue(fill.symbol) ?? stringValue(proposal.symbol) ?? symbolFromTitle(event.title));
  const side = normalizeSide(stringValue(fill.side) ?? stringValue(proposal.side));
  const source = stringValue(fill.source);
  const fillStatus = stringValue(fill.status);
  const companyName = symbol ? symbolMetaBySymbol[symbol]?.companyName : undefined;

  let title = event.title;
  if (event.type === "fill") {
    if (source === "paper") title = `${paperActionLabel(side)} ${symbol ?? "Trade"}`;
    else if (fillStatus === "filled") title = `${executedActionLabel(side)} ${symbol ?? "Position"}`;
    else title = `${actionLabel(side)} ${symbol ?? "Trade"} Pending`;
  } else if (event.type === "block") {
    title = `${actionLabel(side)} ${symbol ?? "Proposal"} Blocked`;
  } else if (event.type === "pending_approval") {
    title = `${actionLabel(side)} ${symbol ?? "Proposal"} Awaiting Approval`;
  } else if (event.type === "kill_switch") {
    title = "Kill Switch Triggered";
  } else if (event.type === "run_failed") {
    title = "Strategy Run Failed";
  }

  return {
    title,
    detail: notificationDetail(event),
    timestamp: new Date(event.createdAt).toLocaleString(),
    symbol,
    companyName
  };
}

function notificationDetail(event: NotificationEvent): string {
  const prefix = event.status === "sent" ? "Notification Sent" : event.status === "failed" ? "Notification Failed" : "Notification Skipped";
  const reason = notificationReason(event.error);
  return reason ? `${prefix} - ${reason}` : prefix;
}

function notificationReason(error?: string): string | undefined {
  if (!error) return undefined;
  if (error === "Notifications Webhook Not Configured") return "Notifications Webhook Not Configured";
  if (error === "Notification type is disabled.") return "Type Disabled";
  return error;
}

function actionLabel(side?: OrderSide): string {
  return side === "sell" ? "Sell" : side === "buy" ? "Buy" : "Trade";
}

function executedActionLabel(side?: OrderSide): string {
  return side === "sell" ? "Sold" : side === "buy" ? "Bought" : "Traded";
}

function paperActionLabel(side?: OrderSide): string {
  return side === "sell" ? "Paper Sell" : side === "buy" ? "Paper Buy" : "Paper Trade";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function symbolFromTitle(title?: string): string | undefined {
  if (!title) return undefined;
  const match = title.match(/\b[A-Z][A-Z0-9.-]{0,9}\b/);
  return match?.[0];
}

function normalizeSymbol(symbol?: string): string | undefined {
  const value = symbol?.trim().toUpperCase();
  return value ? value : undefined;
}

function normalizeSide(side?: string): OrderSide | undefined {
  return side === "buy" || side === "sell" ? side : undefined;
}
