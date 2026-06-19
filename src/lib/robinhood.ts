import type {
  BrokerageAccount,
  BrokerQuote,
  EquityOrder,
  EquityPosition,
  ExecutedOrder,
  MarketHours,
  OrderSide,
  OrderType,
  Portfolio,
  ReviewedOrder,
  TimeInForce,
  BrokerGateway,
  EquityOrderInput
} from "./types";
import { clearMcpOAuthTokens, getMcpAccessToken } from "./mcp-oauth";
import { normalizeSymbol } from "./money";

export const ROBINHOOD_TRADING_MCP_URL = "https://agent.robinhood.com/mcp/trading";
const DEFAULT_MCP_PROTOCOL_VERSION = "2025-03-26";

export interface RobinhoodMcpHealth {
  adapter: "mock" | "mcp";
  ok: boolean;
  configured: boolean;
  authenticated: boolean;
  url?: string;
  protocolVersion: string;
  transport: "http+sse";
  tools: string[];
  checkedAt: string;
  error?: string;
  warning?: string;
}

export function getRobinhoodGateway(): BrokerGateway {
  if (process.env.ROBINHOOD_ADAPTER === "mcp") return new HttpMcpRobinhoodGateway();
  return new MockRobinhoodGateway();
}

class HttpMcpRobinhoodGateway implements BrokerGateway {
  async getAccounts(): Promise<BrokerageAccount[]> {
    const raw = await this.callTool("get_accounts", {});
    const accounts = Array.isArray(raw?.accounts) ? raw.accounts : Array.isArray(raw) ? raw : [];
    return accounts.map((item: any) => ({
      accountNumber: String(item.account_number ?? item.accountNumber),
      // Robinhood labels accounts with `nickname` (e.g. "Agentic"); fall back to type.
      label: String(item.nickname ?? item.label ?? item.brokerage_account_type ?? item.type ?? "Brokerage account"),
      agenticAllowed: Boolean(item.agentic_allowed ?? item.agenticAllowed)
    }));
  }

  async getPortfolio(accountNumber: string): Promise<Portfolio> {
    const raw = await this.callTool("get_portfolio", { account_number: accountNumber });
    // Robinhood returns buying_power as a nested object: { buying_power, display_currency, ... }.
    const buyingPowerRaw = raw.buying_power ?? raw.buyingPower;
    const buyingPower =
      buyingPowerRaw && typeof buyingPowerRaw === "object"
        ? number(buyingPowerRaw.buying_power ?? buyingPowerRaw.amount)
        : number(buyingPowerRaw);
    return {
      accountNumber,
      totalMarketValue: number(raw.total_value ?? raw.total_market_value ?? raw.totalMarketValue),
      buyingPower,
      equityMarketValue: number(raw.equity_value ?? raw.equity_market_value ?? raw.equityMarketValue),
      optionMarketValue: number(raw.options_value ?? raw.option_market_value ?? raw.optionMarketValue ?? 0),
      cash: number(raw.cash ?? 0)
    };
  }

  async getEquityPositions(accountNumber: string): Promise<EquityPosition[]> {
    const raw = await this.callTool("get_equity_positions", { account_number: accountNumber });
    const rows = Array.isArray(raw?.positions) ? raw.positions : Array.isArray(raw?.results) ? raw.results : Array.isArray(raw) ? raw : [];
    const positions: EquityPosition[] = rows
      .map((item: any) => ({
        symbol: normalizeSymbol(String(item.symbol ?? "")),
        quantity: number(item.quantity),
        // Robinhood reports average cost as `average_buy_price` (already reflects partial sells).
        averageCost: number(item.average_buy_price ?? item.average_cost ?? item.averageCost),
        marketValue: number(item.market_value ?? item.marketValue)
      }))
      .filter((position: EquityPosition) => position.symbol && position.quantity !== 0);

    // Robinhood positions carry no market value — derive it from live quotes (fall back to cost).
    if (positions.length > 0) {
      try {
        const quotes = await this.getEquityQuotes(accountNumber, positions.map((position) => position.symbol));
        for (const position of positions) {
          if (position.marketValue > 0) continue;
          const price = quotes[position.symbol]?.price;
          position.marketValue = price && price > 0 ? position.quantity * price : position.quantity * position.averageCost;
        }
      } catch {
        for (const position of positions) {
          if (position.marketValue <= 0) position.marketValue = position.quantity * position.averageCost;
        }
      }
    }
    return positions;
  }

  async getEquityOrders(accountNumber: string): Promise<EquityOrder[]> {
    const raw = await this.callTool("get_equity_orders", { account_number: accountNumber });
    const orders = Array.isArray(raw?.orders) ? raw.orders : Array.isArray(raw?.results) ? raw.results : Array.isArray(raw) ? raw : [];
    return orders.map((item: any) => ({
      id: String(item.id ?? item.order_id),
      symbol: normalizeSymbol(String(item.symbol)),
      side: item.side,
      type: item.type,
      state: String(item.state),
      quantity: optionalNumber(item.quantity),
      dollarAmount: optionalNumber(item.dollar_based_amount ?? item.dollar_amount ?? item.dollarAmount),
      filledQuantity: optionalNumber(item.cumulative_quantity ?? item.filled_quantity ?? item.filledQuantity),
      averagePrice: optionalNumber(item.average_price ?? item.averagePrice),
      createdAt: String(item.created_at ?? item.createdAt ?? ""),
      updatedAt: item.last_transaction_at ?? item.updated_at ?? item.updatedAt,
      placedAgent: item.placed_agent ?? item.placedAgent
    }));
  }

  async getEquityQuotes(accountNumber: string, symbols: string[]): Promise<Record<string, BrokerQuote>> {
    try {
      const raw = await this.callTool("get_equity_quotes", {
        account_number: accountNumber,
        symbols: symbols.map(normalizeSymbol)
      });
      const entries = Array.isArray(raw?.results) ? raw.results : Array.isArray(raw?.quotes) ? raw.quotes : Array.isArray(raw) ? raw : [];
      return Object.fromEntries(
        entries.map((item: any) => {
          // Robinhood nests the live quote under `quote` and pairs it with `close`.
          const q = item.quote ?? item;
          const symbol = normalizeSymbol(String(q.symbol ?? item.symbol));
          return [
            symbol,
            {
              symbol,
              price: optionalNumber(q.last_trade_price ?? q.last_non_reg_trade_price ?? q.price ?? q.last_price),
              bid: optionalNumber(q.bid_price ?? q.bid),
              ask: optionalNumber(q.ask_price ?? q.ask),
              asOf: q.venue_last_trade_time ?? q.as_of ?? item.as_of,
              provider: "robinhood"
            } satisfies BrokerQuote
          ];
        })
      );
    } catch {
      return {};
    }
  }

  async getEquityTradability(accountNumber: string, symbols: string[]) {
    const raw = await this.callTool("get_equity_tradability", {
      account_number: accountNumber,
      symbols: symbols.map(normalizeSymbol)
    });
    const entries = Array.isArray(raw?.results) ? raw.results : Array.isArray(raw) ? raw : [];
    return Object.fromEntries(
      entries.map((item: any) => {
        const symbol = normalizeSymbol(String(item.symbol));
        const active = item.state ? item.state === "active" : true;
        // Robinhood spells the flag `tradeable`; fractional is a string enum ("tradable").
        const tradable = Boolean(item.tradeable ?? item.tradable ?? item.is_tradable ?? true) && active;
        const fractional =
          item.fractional_tradability !== undefined
            ? item.fractional_tradability === "tradable"
            : Boolean(item.fractional ?? item.fractional_tradable);
        return [
          symbol,
          {
            tradable,
            fractional,
            reason: tradable ? item.reason : item.reason ?? `${symbol} is ${item.state ?? "not tradable"}.`
          }
        ];
      })
    );
  }

  async reviewEquityOrder(input: EquityOrderInput): Promise<ReviewedOrder> {
    const raw = await this.callTool("review_equity_order", toMcpOrder(input));
    return {
      estimatedNotional: number(
        raw.estimated_cost ?? raw.estimated_notional ?? raw.notional ?? raw.total ?? raw.estimated_amount ?? input.dollarAmount ?? 0
      ),
      alerts: Array.isArray(raw.alerts) ? raw.alerts.map(String) : [],
      raw
    };
  }

  async placeEquityOrder(input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> {
    const raw = await this.callTool("place_equity_order", { ...toMcpOrder(input), ref_id: input.refId });
    return {
      orderId: raw.id ?? raw.order_id,
      refId: input.refId,
      state: String(raw.state ?? "submitted"),
      filledQuantity: optionalNumber(raw.cumulative_quantity ?? raw.filled_quantity ?? raw.filledQuantity),
      averagePrice: optionalNumber(raw.average_price ?? raw.averagePrice),
      raw
    };
  }

  async cancelEquityOrder(accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    const raw = await this.callTool("cancel_equity_order", { account_number: accountNumber, order_id: orderId });
    return { orderId, refId: crypto.randomUUID(), state: String(raw.state ?? "cancel_requested"), raw };
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    return callRobinhoodMcpTool(name, args);
  }
}

export async function getRobinhoodMcpHealth(): Promise<RobinhoodMcpHealth> {
  const adapter: RobinhoodMcpHealth["adapter"] = process.env.ROBINHOOD_ADAPTER === "mcp" ? "mcp" : "mock";
  const checkedAt = new Date().toISOString();
  const protocolVersion = getRobinhoodMcpProtocolVersion();
  const base = {
    adapter,
    protocolVersion,
    transport: "http+sse" as const,
    checkedAt,
    tools: [] as string[]
  };

  if (adapter !== "mcp") {
    return {
      ...base,
      ok: true,
      configured: false,
      authenticated: false,
      warning: "ROBINHOOD_ADAPTER is mock; set ROBINHOOD_ADAPTER=mcp to use Robinhood Trading MCP."
    };
  }

  const url = getRobinhoodMcpUrl();
  const token = await getMcpAccessToken();
  if (!token) {
    return {
      ...base,
      ok: false,
      configured: true,
      authenticated: false,
      url,
      error: "No Robinhood MCP access token is stored or configured. Connect OAuth or set ROBINHOOD_MCP_AUTH_TOKEN."
    };
  }

  let warning: string | undefined;
  try {
    await callRobinhoodMcpMethod("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "Robinhood Agentic Trading", version: "0.1.0" }
    });
  } catch (error) {
    // Some HTTP MCP proxies accept direct tools/list calls. Keep this diagnostic
    // non-fatal and let tools/list decide whether the connection is usable.
    warning = `initialize failed: ${messageFromError(error)}`;
  }

  try {
    const result = await callRobinhoodMcpMethod("tools/list", {});
    const tools = Array.isArray(result?.tools)
      ? result.tools.map((tool: any) => String(tool?.name ?? "")).filter(Boolean).sort()
      : [];
    return { ...base, ok: true, configured: true, authenticated: true, url, tools, warning };
  } catch (error) {
    return {
      ...base,
      ok: false,
      configured: true,
      authenticated: true,
      url,
      error: [warning, messageFromError(error)].filter(Boolean).join("; ")
    };
  }
}

export async function callRobinhoodMcpTool(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await callRobinhoodMcpMethod("tools/call", { name, arguments: args });
  return unpackMcpToolResult(result);
}

export async function callRobinhoodMcpMethod(method: string, params: Record<string, unknown>): Promise<any> {
  const token = await getMcpAccessToken();
  const response = await fetch(getRobinhoodMcpUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": getRobinhoodMcpProtocolVersion(),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params
    })
  });

  if (response.status === 401) clearMcpOAuthTokens();

  const body = await response.text();
  const payload = parseMcpResponseBody(body, response.headers.get("content-type"));
  const errorMessage = mcpErrorMessage(payload);
  if (!response.ok) {
    throw new Error(`Robinhood MCP HTTP ${response.status}${errorMessage ? `: ${errorMessage}` : ""}`);
  }
  if (errorMessage) throw new Error(errorMessage);
  return payload.result;
}

export function parseMcpResponseBody(body: string, contentType: string | null): { result?: any; error?: any } {
  const trimmed = body.trim();
  if (!trimmed) return {};
  if (isSseResponse(trimmed, contentType)) return parseSseMcpResponse(trimmed);
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Robinhood MCP returned a non-object JSON payload.");
  return parsed as { result?: any; error?: any };
}

function parseSseMcpResponse(body: string): { result?: any; error?: any } {
  const events: string[] = [];
  let current: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (line === "") {
      if (current.length > 0) {
        events.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    if (line.startsWith("data:")) current.push(line.slice(5).trimStart());
  }
  if (current.length > 0) events.push(current.join("\n"));

  let lastObject: { result?: any; error?: any } | undefined;
  for (const event of events) {
    const data = event.trim();
    if (!data || data === "[DONE]") continue;
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      lastObject = parsed as { result?: any; error?: any };
      if ("result" in parsed || "error" in parsed) return lastObject;
    }
  }
  if (lastObject) return lastObject;
  throw new Error("Robinhood MCP SSE response did not include a JSON-RPC data event.");
}

function unpackMcpToolResult(raw: any): unknown {
  const result = raw?.structuredContent ?? raw?.content?.[0]?.text ?? raw;
  let parsed: unknown = result;
  if (typeof result === "string") {
    try {
      parsed = JSON.parse(result);
    } catch {
      return { text: result };
    }
  }
  // Robinhood's MCP wraps every tool output in a `data` envelope, with a sibling
  // guide string. Unwrap it so gateway callers read fields directly.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "data" in (parsed as Record<string, unknown>)) {
    return (parsed as { data: unknown }).data;
  }
  return parsed;
}

function mcpErrorMessage(payload: { error?: any }): string | undefined {
  if (!payload.error) return undefined;
  if (typeof payload.error === "string") return payload.error;
  return payload.error.message ? String(payload.error.message) : JSON.stringify(payload.error);
}

function isSseResponse(body: string, contentType: string | null): boolean {
  return Boolean(contentType?.includes("text/event-stream")) || body.startsWith("event:") || body.startsWith("data:") || body.includes("\ndata:");
}

function getRobinhoodMcpUrl(): string {
  return process.env.ROBINHOOD_MCP_URL || ROBINHOOD_TRADING_MCP_URL;
}

function getRobinhoodMcpProtocolVersion(): string {
  return process.env.ROBINHOOD_MCP_PROTOCOL_VERSION || DEFAULT_MCP_PROTOCOL_VERSION;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MOCK_PRICES: Record<string, number> = {
  AAPL: 200,
  VOO: 500,
  MSFT: 420,
  NVDA: 125,
  AMZN: 180,
  JPM: 175,
  AMD: 165,
  TSLA: 180,
  META: 480,
  NFLX: 600,
  GOOG: 170
};

class MockRobinhoodGateway implements BrokerGateway {
  async getAccounts(): Promise<BrokerageAccount[]> {
    return [{ accountNumber: "RH-MOCK-AGENT", label: "Mock agentic account", agenticAllowed: true }];
  }

  async getPortfolio(accountNumber: string): Promise<Portfolio> {
    return { accountNumber, totalMarketValue: 100, buyingPower: 40, equityMarketValue: 60, optionMarketValue: 0, cash: 40 };
  }

  async getEquityPositions(): Promise<EquityPosition[]> {
    return [
      { symbol: "VOO", quantity: 0.08, averageCost: 500, marketValue: 40, sector: "ETF", industry: "Index Fund" },
      { symbol: "AAPL", quantity: 0.1, averageCost: 200, marketValue: 20, sector: "Technology", industry: "Consumer Electronics" }
    ];
  }

  async getEquityOrders(): Promise<EquityOrder[]> {
    return [];
  }

  async getEquityQuotes(_accountNumber: string, symbols: string[]): Promise<Record<string, BrokerQuote>> {
    const quotes = await Promise.all(
      symbols.map(async (symbol) => {
        const normalized = normalizeSymbol(symbol);

        // Fetch live quotes from Yahoo Finance first in non-test environments
        if (process.env.NODE_ENV !== "test") {
          const yf = await fetchYahooFinanceQuote(normalized);
          if (yf) {
            return [
              normalized,
              {
                symbol: normalized,
                price: yf.price,
                bid: yf.bid,
                ask: yf.ask,
                volume: yf.volume > 0 ? yf.volume : undefined,
                asOf: new Date().toISOString(),
                provider: "yahoo-finance"
              }
            ] as const;
          }
        }

        if (MOCK_PRICES[normalized]) {
          const price = MOCK_PRICES[normalized];
          return [
            normalized,
            {
              symbol: normalized,
              price,
              bid: price * 0.999,
              ask: price * 1.001,
              asOf: new Date().toISOString(),
              provider: "mock-robinhood"
            }
          ] as const;
        }

        // Fallback for non-mock symbols in test mode (so tests never make network calls or fail)
        if (process.env.NODE_ENV === "test") {
          return [
            normalized,
            {
              symbol: normalized,
              price: 100,
              bid: 99.9,
              ask: 100.1,
              asOf: new Date().toISOString(),
              provider: "mock-robinhood"
            }
          ] as const;
        }

        // In normal development/production mode, if we can't find the Yahoo Finance quote and it's not a mock symbol, throw an error!
        throw new Error(`Real-time quote for symbol ${normalized} is unavailable.`);
      })
    );
    return Object.fromEntries(quotes);
  }

  async getEquityTradability(_accountNumber: string, symbols: string[]) {
    return Object.fromEntries(symbols.map((symbol) => [normalizeSymbol(symbol), { tradable: true, fractional: true }]));
  }

  async reviewEquityOrder(input: EquityOrderInput): Promise<ReviewedOrder> {
    const quotes = await this.getEquityQuotes(input.accountNumber, [input.symbol]);
    const price = quotes[normalizeSymbol(input.symbol)]?.price ?? 100;
    const estPrice = input.limitPrice ?? input.stopPrice ?? price;
    return { estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * estPrice, alerts: [], raw: { mock: true } };
  }

  async placeEquityOrder(input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> {
    const quotes = await this.getEquityQuotes(input.accountNumber, [input.symbol]);
    const price = quotes[normalizeSymbol(input.symbol)]?.price ?? 100;
    const estPrice = input.limitPrice ?? input.stopPrice ?? price;
    const quantity = input.quantity ?? (input.dollarAmount ? input.dollarAmount / estPrice : undefined);
    return {
      orderId: `mock-${input.refId}`,
      refId: input.refId,
      state: "filled",
      filledQuantity: quantity,
      averagePrice: estPrice,
      raw: { mock: true }
    };
  }

  async cancelEquityOrder(_accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    return { orderId, refId: crypto.randomUUID(), state: "cancel_requested", raw: { mock: true } };
  }
}

// SHORT_SELLING: Robinhood's MCP place_equity_order only accepts side "buy" or
// "sell" (review_equity_order docs explicitly state "no short sells"). If
// Robinhood adds equity shorting, this function will need to translate "short"
// to whatever broker-side value they use, and may require additional parameters
// (e.g. borrow/locate confirmation). Until then, policy.ts blocks short/cover
// before this code is reached.
function toMcpOrder(input: EquityOrderInput): Record<string, unknown> {
  return {
    account_number: input.accountNumber,
    symbol: normalizeSymbol(input.symbol),
    side: input.side,
    type: input.type,
    quantity: input.quantity?.toString(),
    dollar_amount: input.dollarAmount?.toFixed(2),
    limit_price: input.limitPrice?.toFixed(2),
    stop_price: input.stopPrice?.toFixed(2),
    time_in_force: input.timeInForce,
    market_hours: input.marketHours
  };
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return number(value);
}

export async function fetchYahooFinanceQuote(symbol: string): Promise<{ price: number; bid: number; ask: number; prevClose: number; volume: number } | undefined> {
  const clean = encodeURIComponent(symbol.toUpperCase());
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${clean}?interval=1d&range=1d`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return undefined;
    const payload = await response.json() as any;
    const meta = payload?.chart?.result?.[0]?.meta;
    if (!meta) return undefined;
    const price = meta.regularMarketPrice;
    if (typeof price !== "number" || price <= 0) return undefined;
    const prevClose = meta.chartPreviousClose ?? price;
    // Prefer regularMarketVolume (always present, includes full day even after close).
    // Fall back to the candle array volume if the meta field is absent.
    const quote = payload?.chart?.result?.[0]?.indicators?.quote?.[0];
    const volume = Number(meta.regularMarketVolume ?? quote?.volume?.[0] ?? 0);
    return {
      price,
      bid: price * 0.999,
      ask: price * 1.001,
      prevClose,
      volume
    };
  } catch {
    clearTimeout(timeout);
    return undefined;
  }
}
