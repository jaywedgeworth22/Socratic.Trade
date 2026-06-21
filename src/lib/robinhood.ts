import type {
  AccountCapabilities,
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
import type { OHLCBar } from "./indicators";
import { clearMcpOAuthTokens, getMcpAccessToken } from "./mcp-oauth";
import { normalizeSymbol } from "./money";

export const ROBINHOOD_TRADING_MCP_URL = "https://agent.robinhood.com/mcp/trading";
const DEFAULT_MCP_PROTOCOL_VERSION = "2025-03-26";

export interface RobinhoodMcpHealth {
  adapter: "mcp";
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
  // Robinhood is MCP-only. When it isn't connected, the MCP gateway surfaces honest
  // errors and the health card shows "not connected" — it never returns fabricated data.
  return new HttpMcpRobinhoodGateway();
}

// Local "Test" broker: real market quotes (Yahoo) + simulated fills, no real broker.
// Honestly labeled "Test" — it never impersonates Robinhood or any real account.
export function getTestGateway(): BrokerGateway {
  return new TestBrokerGateway();
}

class HttpMcpRobinhoodGateway implements BrokerGateway {
  async getAccounts(): Promise<BrokerageAccount[]> {
    const raw = await this.callTool("get_accounts", {}) as Record<string, unknown>;
    const accounts = Array.isArray(raw?.accounts) ? raw.accounts : Array.isArray(raw) ? raw : [];
    return accounts.map((item: Record<string, unknown>) => {
      // Options level: Robinhood returns an integer 0-4 (0 = no options).
      const rawOptLevel = typeof item.option_level === "number" ? item.option_level : undefined;
      const optionsLevel = (rawOptLevel !== undefined && rawOptLevel >= 0 && rawOptLevel <= 4)
        ? (rawOptLevel as 0 | 1 | 2 | 3 | 4)
        : undefined;
      const optionsTrading = optionsLevel !== undefined ? optionsLevel > 0 : false;

      // Margin: Robinhood distinguishes "cash" vs "margin" account_type.
      const rawType = String(item.account_type ?? item.type ?? "").toLowerCase();
      const marginEnabled = rawType === "margin" || rawType.includes("margin");

      // Account structure for tax-regime classification.
      const rawBrokerageType = String(item.brokerage_account_type ?? "").toLowerCase();
      const accountType: AccountCapabilities["accountType"] =
        rawBrokerageType.includes("roth") ? "roth_ira"
        : rawBrokerageType.includes("ira") || rawBrokerageType.includes("traditional") ? "traditional_ira"
        : "brokerage";

      const capabilities: AccountCapabilities = {
        equityTrading: true,
        // Robinhood MCP does not support short selling. The MCP's review_equity_order
        // docs explicitly state "no short sells". Hardcoded false regardless of account type.
        shortSelling: false,
        optionsTrading,
        optionsLevel: optionsTrading ? optionsLevel : undefined,
        futuresTrading: false,
        cryptoTrading: false,
        marginEnabled,
        accountType
      };

      return {
        accountNumber: String(item.account_number ?? item.accountNumber),
        // Robinhood labels accounts with `nickname` (e.g. "Agentic"); fall back to type.
        label: String(item.nickname ?? item.label ?? item.brokerage_account_type ?? item.type ?? "Brokerage account"),
        agenticAllowed: Boolean(item.agentic_allowed ?? item.agenticAllowed),
        capabilities
      };
    });
  }

  async getPortfolio(accountNumber: string): Promise<Portfolio> {
    const raw = await this.callTool("get_portfolio", { account_number: accountNumber }) as Record<string, unknown>;
    // Robinhood returns buying_power as a nested object: { buying_power, display_currency, ... }.
    const buyingPowerRaw = raw.buying_power ?? raw.buyingPower;
    const buyingPower =
      buyingPowerRaw && typeof buyingPowerRaw === "object"
        ? number((buyingPowerRaw as Record<string, unknown>).buying_power ?? (buyingPowerRaw as Record<string, unknown>).amount)
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
    const raw = await this.callTool("get_equity_positions", { account_number: accountNumber }) as Record<string, unknown>;
    const rows = Array.isArray(raw?.positions) ? raw.positions : Array.isArray(raw?.results) ? raw.results : Array.isArray(raw) ? raw : [];
    const positions: EquityPosition[] = rows
      .map((item: Record<string, unknown>) => ({
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
    const raw = await this.callTool("get_equity_orders", { account_number: accountNumber }) as Record<string, unknown>;
    const orders = Array.isArray(raw?.orders) ? raw.orders : Array.isArray(raw?.results) ? raw.results : Array.isArray(raw) ? raw : [];
    return orders.map((item: Record<string, unknown>) => ({
      id: String(item.id ?? item.order_id),
      symbol: normalizeSymbol(String(item.symbol)),
      side: item.side as OrderSide,
      type: item.type as OrderType,
      state: String(item.state),
      quantity: optionalNumber(item.quantity),
      dollarAmount: optionalNumber(item.dollar_based_amount ?? item.dollar_amount ?? item.dollarAmount),
      filledQuantity: optionalNumber(item.cumulative_quantity ?? item.filled_quantity ?? item.filledQuantity),
      averagePrice: optionalNumber(item.average_price ?? item.averagePrice),
      createdAt: String(item.created_at ?? item.createdAt ?? ""),
      updatedAt: optionalString(item.last_transaction_at ?? item.updated_at ?? item.updatedAt),
      placedAgent: optionalString(item.placed_agent ?? item.placedAgent)
    }));
  }

  async getEquityQuotes(accountNumber: string, symbols: string[]): Promise<Record<string, BrokerQuote>> {
    try {
      const raw = await this.callTool("get_equity_quotes", {
        account_number: accountNumber,
        symbols: symbols.map(normalizeSymbol)
      }) as Record<string, unknown>;
      const entries = Array.isArray(raw?.results) ? raw.results : Array.isArray(raw?.quotes) ? raw.quotes : Array.isArray(raw) ? raw : [];
      return Object.fromEntries(
        entries.map((item: Record<string, unknown>) => {
          // Robinhood nests the live quote under `quote` and pairs it with `close`.
          const q = (item.quote ?? item) as Record<string, unknown>;
          const symbol = normalizeSymbol(String(q.symbol ?? item.symbol));
          return [
            symbol,
            {
              symbol,
              price: optionalNumber(q.last_trade_price ?? q.last_non_reg_trade_price ?? q.price ?? q.last_price),
              bid: optionalNumber(q.bid_price ?? q.bid),
              ask: optionalNumber(q.ask_price ?? q.ask),
              asOf: optionalString(q.venue_last_trade_time ?? q.as_of ?? item.as_of),
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
    }) as Record<string, unknown>;
    const entries = Array.isArray(raw?.results) ? raw.results : Array.isArray(raw) ? raw : [];
    return Object.fromEntries(
      entries.map((item: Record<string, unknown>) => {
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
            reason: tradable ? (item.reason ? String(item.reason) : undefined) : String(item.reason ?? `${symbol} is ${String(item.state ?? "not tradable")}.`)
          }
        ];
      })
    );
  }

  async reviewEquityOrder(input: EquityOrderInput): Promise<ReviewedOrder> {
    const raw = await this.callTool("review_equity_order", toMcpOrder(input)) as Record<string, unknown>;
    return {
      estimatedNotional: number(
        raw.estimated_cost ?? raw.estimated_notional ?? raw.notional ?? raw.total ?? raw.estimated_amount ?? input.dollarAmount ?? 0
      ),
      alerts: Array.isArray(raw.alerts) ? raw.alerts.map(String) : [],
      raw
    };
  }

  async placeEquityOrder(input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> {
    const raw = await this.callTool("place_equity_order", { ...toMcpOrder(input), ref_id: input.refId }) as Record<string, unknown>;
    return {
      orderId: String(raw.id ?? raw.order_id),
      refId: input.refId,
      state: String(raw.state ?? "submitted"),
      filledQuantity: optionalNumber(raw.cumulative_quantity ?? raw.filled_quantity ?? raw.filledQuantity),
      averagePrice: optionalNumber(raw.average_price ?? raw.averagePrice),
      raw
    };
  }

  async cancelEquityOrder(accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    const raw = await this.callTool("cancel_equity_order", { account_number: accountNumber, order_id: orderId }) as Record<string, unknown>;
    return { orderId, refId: crypto.randomUUID(), state: String(raw.state ?? "cancel_requested"), raw };
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return callRobinhoodMcpTool(name, args);
  }
}

export async function getRobinhoodMcpHealth(): Promise<RobinhoodMcpHealth> {
  const checkedAt = new Date().toISOString();
  const protocolVersion = getRobinhoodMcpProtocolVersion();
  const base = {
    adapter: "mcp" as const,
    protocolVersion,
    transport: "http+sse" as const,
    checkedAt,
    tools: [] as string[]
  };

  if (process.env.ROBINHOOD_ADAPTER !== "mcp") {
    return {
      ...base,
      ok: true,
      configured: false,
      authenticated: false,
      warning: "Robinhood is not connected. Connect your Robinhood agentic account to enable it."
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
      clientInfo: { name: "Agentic Trading", version: "0.1.0" }
    });
  } catch (error) {
    // Some HTTP MCP proxies accept direct tools/list calls. Keep this diagnostic
    // non-fatal and let tools/list decide whether the connection is usable.
    warning = `initialize failed: ${messageFromError(error)}`;
  }

  try {
    const result = await callRobinhoodMcpMethod("tools/list", {});
    const resultObj = result as { tools?: Array<{ name?: string }> };
    const tools = Array.isArray(resultObj?.tools)
      ? resultObj.tools.map((tool: { name?: string }) => String(tool?.name ?? "")).filter(Boolean).sort()
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

export async function callRobinhoodMcpTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await callRobinhoodMcpMethod("tools/call", { name, arguments: args });
  return unpackMcpToolResult(result);
}

export async function callRobinhoodMcpMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
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

export function parseMcpResponseBody(body: string, contentType: string | null): { result?: unknown; error?: unknown } {
  const trimmed = body.trim();
  if (!trimmed) return {};
  if (isSseResponse(trimmed, contentType)) return parseSseMcpResponse(trimmed);
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { error: { message: trimmed } };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: { message: "Robinhood MCP returned a non-object JSON payload." } };
  return parsed as { result?: unknown; error?: unknown };
}

function parseSseMcpResponse(body: string): { result?: unknown; error?: unknown } {
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

  let lastObject: { result?: unknown; error?: unknown } | undefined;
  for (const event of events) {
    const data = event.trim();
    if (!data || data === "[DONE]") continue;
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      lastObject = parsed as { result?: unknown; error?: unknown };
      if ("result" in parsed || "error" in parsed) return lastObject;
    }
  }
  if (lastObject) return lastObject;
  throw new Error("Robinhood MCP SSE response did not include a JSON-RPC data event.");
}

function unpackMcpToolResult(raw: unknown): unknown {
  const rawObj = raw as Record<string, unknown> | undefined;
  const result = rawObj?.structuredContent ?? (rawObj?.content as Array<{ text?: unknown }>)?.[0]?.text ?? raw;
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

function mcpErrorMessage(payload: { error?: unknown }): string | undefined {
  if (!payload.error) return undefined;
  if (typeof payload.error === "string") return payload.error;
  const err = payload.error as Record<string, unknown>;
  return err.message ? String(err.message) : JSON.stringify(payload.error);
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

class TestBrokerGateway implements BrokerGateway {
  async getAccounts(): Promise<BrokerageAccount[]> {
    return [{
      accountNumber: "TEST",
      label: "Test",
      agenticAllowed: true,
      capabilities: {
        equityTrading: true,
        shortSelling: false,
        optionsTrading: false,
        futuresTrading: false,
        cryptoTrading: false,
        marginEnabled: false,
        accountType: "brokerage"
      }
    }];
  }

  async getPortfolio(accountNumber: string): Promise<Portfolio> {
    return { accountNumber, totalMarketValue: 0, buyingPower: 0, equityMarketValue: 0, optionMarketValue: 0, cash: 0 };
  }

  async getEquityPositions(): Promise<EquityPosition[]> {
    return [];
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
              provider: "test"
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
              provider: "test"
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
    return { estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * estPrice, alerts: [], raw: { test: true } };
  }

  async placeEquityOrder(input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> {
    const quotes = await this.getEquityQuotes(input.accountNumber, [input.symbol]);
    const price = quotes[normalizeSymbol(input.symbol)]?.price ?? 100;
    const estPrice = input.limitPrice ?? input.stopPrice ?? price;
    const quantity = input.quantity ?? (input.dollarAmount ? input.dollarAmount / estPrice : undefined);
    return {
      orderId: `test-${input.refId}`,
      refId: input.refId,
      state: "filled",
      filledQuantity: quantity,
      averagePrice: estPrice,
      raw: { test: true }
    };
  }

  async cancelEquityOrder(_accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    return { orderId, refId: crypto.randomUUID(), state: "cancel_requested", raw: { test: true } };
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

// ── Robinhood MCP market-DATA helpers (historicals + fundamentals) ────────────
// These reuse the authenticated MCP transport but are pure read-only DATA calls,
// independent of the BrokerGateway interface. They are INERT unless ROBINHOOD_ADAPTER=mcp
// and a token is present — every path returns null/{} otherwise, so the OHLC cascade and
// enrichment cascade degrade exactly as before when Robinhood is not connected.

export function robinhoodMcpDataEnabled(): boolean {
  return process.env.ROBINHOOD_ADAPTER === "mcp";
}

/**
 * Fetch daily OHLC history for a symbol via Robinhood MCP `get_equity_historicals`.
 * Returns null when Robinhood isn't connected, the call fails, or <2 bars come back —
 * so it slots into the keyed-first OHLC cascade as just another tier.
 */
export async function fetchRobinhoodHistoricals(
  symbol: string,
  opts: { interval?: string; span?: string } = {}
): Promise<OHLCBar[] | null> {
  if (!robinhoodMcpDataEnabled()) return null;
  const sym = normalizeSymbol(symbol);
  if (!sym) return null;
  try {
    const raw = await callRobinhoodMcpTool("get_equity_historicals", {
      symbols: [sym],
      symbol: sym,
      interval: opts.interval ?? "day",
      span: opts.span ?? "5year",
      bounds: "regular"
    });
    const bars = parseRobinhoodHistoricals(raw, sym);
    return bars.length >= 2 ? bars : null;
  } catch {
    return null;
  }
}

/** Defensive parser for Robinhood historicals — tolerates several envelope shapes. */
export function parseRobinhoodHistoricals(raw: unknown, symbol: string): OHLCBar[] {
  const root = raw as Record<string, unknown> | undefined;
  let rows: unknown[] = [];
  if (root && Array.isArray(root.historicals)) {
    rows = root.historicals as unknown[];
  } else if (root && Array.isArray(root.results)) {
    const results = root.results as Array<Record<string, unknown>>;
    const match = results.find((r) => normalizeSymbol(String(r.symbol ?? "")) === symbol);
    if (match && Array.isArray(match.historicals)) rows = match.historicals as unknown[];
    else if (results.length > 0 && Array.isArray(results[0]?.historicals)) rows = results[0]!.historicals as unknown[];
    else rows = results;
  } else if (Array.isArray(raw)) {
    rows = raw as unknown[];
  }

  const bars: OHLCBar[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const close = firstNum(r, ["close_price", "close", "c"]);
    if (close === undefined) continue;
    const bar: OHLCBar = { close };
    const time = optionalString(r.begins_at ?? r.timestamp ?? r.date ?? r.t);
    if (time !== undefined) bar.time = time;
    const open = firstNum(r, ["open_price", "open", "o"]);
    if (open !== undefined) bar.open = open;
    const high = firstNum(r, ["high_price", "high", "h"]);
    if (high !== undefined) bar.high = high;
    const low = firstNum(r, ["low_price", "low", "l"]);
    if (low !== undefined) bar.low = low;
    const volume = firstNum(r, ["volume", "v"]);
    if (volume !== undefined) bar.volume = volume;
    bars.push(bar);
  }
  return bars;
}

/**
 * Raw `get_equity_fundamentals` output, normalized to a per-symbol map. Returns {} when
 * Robinhood isn't connected. The exact field set is broker-defined; callers map defensively.
 */
export async function fetchRobinhoodFundamentals(symbols: string[]): Promise<Record<string, Record<string, unknown>>> {
  if (!robinhoodMcpDataEnabled()) return {};
  const wanted = Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));
  if (wanted.length === 0) return {};
  try {
    const raw = await callRobinhoodMcpTool("get_equity_fundamentals", { symbols: wanted });
    const root = raw as Record<string, unknown> | undefined;
    const rows = Array.isArray(root?.results) ? root!.results : Array.isArray(root?.fundamentals) ? root!.fundamentals : Array.isArray(raw) ? (raw as unknown[]) : [];
    const out: Record<string, Record<string, unknown>> = {};
    for (const row of rows as Array<Record<string, unknown>>) {
      const sym = normalizeSymbol(String(row.symbol ?? row.ticker ?? ""));
      if (sym) out[sym] = row;
    }
    return out;
  } catch {
    return {};
  }
}

function firstNum(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined || value === "") continue;
    const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return number(value);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text ? text : undefined;
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
    const payload = await response.json() as { chart?: { result?: Array<{ meta?: Record<string, unknown>, indicators?: { quote?: Array<{ volume?: unknown[] }> } }> } };
    const meta = payload?.chart?.result?.[0]?.meta;
    if (!meta) return undefined;
    const price = Number(meta.regularMarketPrice);
    if (!Number.isFinite(price) || price <= 0) return undefined;
    const prevClose = meta.chartPreviousClose ? Number(meta.chartPreviousClose) : price;
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
