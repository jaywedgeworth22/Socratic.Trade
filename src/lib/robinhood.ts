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
  TimeInForce
} from "./types";
import { clearMcpOAuthTokens, getMcpAccessToken } from "./mcp-oauth";
import { normalizeSymbol } from "./money";

export interface RobinhoodGateway {
  getAccounts(): Promise<BrokerageAccount[]>;
  getPortfolio(accountNumber: string): Promise<Portfolio>;
  getEquityPositions(accountNumber: string): Promise<EquityPosition[]>;
  getEquityOrders(accountNumber: string): Promise<EquityOrder[]>;
  getEquityQuotes(accountNumber: string, symbols: string[]): Promise<Record<string, BrokerQuote>>;
  getEquityTradability(accountNumber: string, symbols: string[]): Promise<Record<string, { tradable: boolean; fractional: boolean; reason?: string }>>;
  reviewEquityOrder(input: EquityOrderInput): Promise<ReviewedOrder>;
  placeEquityOrder(input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder>;
  cancelEquityOrder(accountNumber: string, orderId: string): Promise<ExecutedOrder>;
}

export interface EquityOrderInput {
  accountNumber: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity?: number;
  dollarAmount?: number;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce: TimeInForce;
  marketHours: MarketHours;
}

export function getRobinhoodGateway(): RobinhoodGateway {
  if (process.env.ROBINHOOD_ADAPTER === "mcp") return new HttpMcpRobinhoodGateway();
  return new MockRobinhoodGateway();
}

class HttpMcpRobinhoodGateway implements RobinhoodGateway {
  private readonly url = required("ROBINHOOD_MCP_URL");

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
    const token = await getMcpAccessToken();
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name, arguments: args }
      })
    });
    if (response.status === 401) clearMcpOAuthTokens();
    if (!response.ok) throw new Error(`Robinhood MCP HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error.message ?? "Robinhood MCP tool failed");
    const result = payload.result?.structuredContent ?? payload.result?.content?.[0]?.text ?? payload.result;
    let parsed: unknown = result;
    if (typeof result === "string") {
      try {
        parsed = JSON.parse(result);
      } catch {
        return { text: result };
      }
    }
    // Robinhood's MCP wraps every tool's output in a `data` envelope (with a sibling
    // `guide` string). Unwrap it so callers read fields directly. Harmless if absent.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "data" in (parsed as Record<string, unknown>)) {
      return (parsed as { data: unknown }).data;
    }
    return parsed;
  }
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

class MockRobinhoodGateway implements RobinhoodGateway {
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

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
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
    const quote = payload?.chart?.result?.[0]?.indicators?.quote?.[0];
    const volume = Number(quote?.volume?.[0] ?? 0);
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
