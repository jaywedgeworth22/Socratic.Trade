import Alpaca from "@alpacahq/alpaca-trade-api";
import crypto from "crypto";
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
import { normalizeSymbol } from "./money";
import { getActiveConnectedAccount, getUserApiKey } from "./db";

export function getAlpacaGateway(userId: string = "local"): BrokerGateway {
  return new AlpacaBrokerGateway(userId);
}

class AlpacaBrokerGateway implements BrokerGateway {
  private alpaca: Alpaca;
  private label: string;
  private isMcp: boolean;
  private mcpUrl?: string;

  constructor(userId: string) {
    const activeAccount = getActiveConnectedAccount(userId);
    const accountKeys =
      activeAccount?.broker === "alpaca" || activeAccount?.broker === "alpaca-mcp"
        ? activeAccount
        : undefined;
    this.isMcp = activeAccount?.broker === "alpaca-mcp";
    this.label = accountKeys?.label || (accountKeys?.environment === "live" ? "Alpaca Brokerage" : "Alpaca Paper");
    const keyId =
      accountKeys?.apiKey ||
      getUserApiKey(userId, "ALPACA_PAPER_API_KEY")?.apiKey ||
      getUserApiKey(userId, "alpaca")?.apiKey ||
      process.env.ALPACA_PAPER_API_KEY ||
      "";
    const secretKey =
      accountKeys?.apiSecret ||
      getUserApiKey(userId, "ALPACA_PAPER_SECRET_KEY")?.apiKey ||
      process.env.ALPACA_PAPER_SECRET_KEY ||
      "";
    
    let baseUrl = accountKeys?.baseUrl?.trim();
    if (this.isMcp) {
      this.mcpUrl = baseUrl || undefined;
    }

    if (baseUrl && !this.isMcp) {
      baseUrl = baseUrl.replace(/\/+$/, "");
      if (baseUrl.toLowerCase().endsWith("/v2")) {
        baseUrl = baseUrl.slice(0, -3);
      }
    }

    const options: any = {
      paper: accountKeys?.environment !== "live",
      usePolygon: false
    };

    if (keyId && !secretKey) {
      options.oauth = keyId;
    } else {
      options.keyId = keyId;
      options.secretKey = secretKey;
    }

    if (baseUrl && !this.isMcp) {
      options.baseUrl = baseUrl;
    }

    this.alpaca = new Alpaca(options);
  }

  private async callMcp<T>(toolName: string, args: Record<string, unknown>, fallbackFn: () => Promise<T>): Promise<T> {
    if (!this.isMcp || !this.mcpUrl) {
      return fallbackFn();
    }
    try {
      const response = await fetch(this.mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args
          }
        })
      });
      if (!response.ok) {
        throw new Error(`Alpaca MCP HTTP ${response.status}`);
      }
      const body = await response.json();
      if (body.error) {
        throw new Error(body.error.message || JSON.stringify(body.error));
      }
      const content = body.result?.content;
      if (Array.isArray(content) && content[0]?.type === "text") {
        try {
          return JSON.parse(content[0].text);
        } catch {
          return content[0].text;
        }
      }
      return body.result;
    } catch (e) {
      console.warn(`Alpaca MCP tool call "${toolName}" failed, falling back to REST:`, e);
      return fallbackFn();
    }
  }


  async getAccounts(): Promise<BrokerageAccount[]> {
    const getCapabilities = (acc: any): AccountCapabilities => {
      const shortSelling = Boolean(acc.shorting_enabled);
      const marginEnabled = shortSelling || String(acc.account_type ?? "").toUpperCase() === "MARGIN";
      return {
        equityTrading: true,
        shortSelling,
        optionsTrading: false,
        futuresTrading: false,
        cryptoTrading: false,
        marginEnabled,
        accountType: "brokerage"
      };
    };

    return this.callMcp<any>("get_account_info", {}, async () => {
      const account = await this.alpaca.getAccount();
      return [
        {
          accountNumber: account.account_number,
          label: this.label,
          agenticAllowed: true,
          capabilities: getCapabilities(account)
        }
      ];
    }).then((res: any) => {
      if (res && res.account_number) {
        return [
          {
            accountNumber: res.account_number,
            label: this.label,
            agenticAllowed: true,
            capabilities: getCapabilities(res)
          }
        ];
      }
      return res;
    });
  }

  async getPortfolio(accountNumber: string): Promise<Portfolio> {
    return this.callMcp<any>("get_account_info", {}, async () => {
      const account = await this.alpaca.getAccount();
      if (account.account_number !== accountNumber) throw new Error("Account mismatch");
      return {
        accountNumber,
        totalMarketValue: number(account.portfolio_value),
        buyingPower: number(account.buying_power),
        equityMarketValue: number(account.equity) - number(account.cash),
        optionMarketValue: 0,
        cash: number(account.cash)
      };
    }).then((res: any) => {
      if (res && res.account_number) {
        return {
          accountNumber,
          totalMarketValue: number(res.portfolio_value),
          buyingPower: number(res.buying_power),
          equityMarketValue: number(res.equity) - number(res.cash),
          optionMarketValue: 0,
          cash: number(res.cash)
        };
      }
      return res;
    });
  }

  async getEquityPositions(accountNumber: string): Promise<EquityPosition[]> {
    return this.callMcp<any>("get_positions", {}, async () => {
      const positions = await this.alpaca.getPositions();
      return positions.map((p: Record<string, unknown>) => ({
        symbol: normalizeSymbol(String(p.symbol)),
        quantity: number(p.qty),
        averageCost: number(p.avg_entry_price),
        marketValue: number(p.market_value),
        sector: undefined,
        industry: undefined
      }));
    }).then((res: any) => {
      if (Array.isArray(res)) {
        return res.map((p: any) => ({
          symbol: normalizeSymbol(String(p.symbol)),
          quantity: number(p.qty),
          averageCost: number(p.avg_entry_price),
          marketValue: number(p.market_value),
          sector: undefined,
          industry: undefined
        }));
      }
      return res;
    });
  }

  async getEquityOrders(accountNumber: string): Promise<EquityOrder[]> {
    return this.callMcp<any>("get_orders", { status: "all" }, async () => {
      const orders = await this.alpaca.getOrders({ status: "all" } as Parameters<typeof this.alpaca.getOrders>[0]);
      return orders.map((o: Record<string, unknown>) => ({
        id: String(o.id),
        symbol: normalizeSymbol(String(o.symbol)),
        side: o.side as OrderSide,
        type: o.type as OrderType,
        state: String(o.status),
        quantity: optionalNumber(o.qty),
        dollarAmount: optionalNumber(o.notional),
        filledQuantity: optionalNumber(o.filled_qty),
        averagePrice: optionalNumber(o.filled_avg_price),
        createdAt: String(o.created_at),
        updatedAt: o.updated_at ? String(o.updated_at) : undefined,
        clientOrderId: o.client_order_id ? String(o.client_order_id) : undefined,
        placedAgent: "alpaca"
      }));
    }).then((res: any) => {
      if (Array.isArray(res)) {
        return res.map((o: any) => ({
          id: String(o.id),
          symbol: normalizeSymbol(String(o.symbol)),
          side: o.side as OrderSide,
          type: o.type as OrderType,
          state: String(o.status),
          quantity: optionalNumber(o.qty),
          dollarAmount: optionalNumber(o.notional),
          filledQuantity: optionalNumber(o.filled_qty),
          averagePrice: optionalNumber(o.filled_avg_price),
          createdAt: String(o.created_at),
          updatedAt: o.updated_at ? String(o.updated_at) : undefined,
          clientOrderId: o.client_order_id ? String(o.client_order_id) : undefined,
          placedAgent: "alpaca"
        }));
      }
      return res;
    });
  }

  async getEquityQuotes(accountNumber: string, symbols: string[]): Promise<Record<string, BrokerQuote>> {
    // Standard quotes method: fall back to REST directly to avoid multi-ticker latency
    const normalizedSymbols = symbols.map(normalizeSymbol);
    try {
      const response = await this.alpaca.getLatestQuotes(normalizedSymbols);
      const quotes: Record<string, BrokerQuote> = {};
      
      for (const [symbol, q] of Object.entries(response)) {
        const anyQ = q as Record<string, number | string>;
        const bid = optionalNumber(anyQ.bp);
        const ask = optionalNumber(anyQ.ap);
        quotes[symbol] = {
          symbol,
          price: ask ?? bid ?? 0,
          bid,
          ask,
          asOf: optionalIso(anyQ.t),
          provider: "alpaca"
        };
      }
      return quotes;
    } catch {
      return {};
    }
  }

  async getEquityTradability(accountNumber: string, symbols: string[]) {
    return Object.fromEntries(symbols.map((symbol) => [normalizeSymbol(symbol), { tradable: true, fractional: true }]));
  }

  async reviewEquityOrder(input: EquityOrderInput): Promise<ReviewedOrder> {
    const quotes = await this.getEquityQuotes(input.accountNumber, [input.symbol]);
    const price = quotes[normalizeSymbol(input.symbol)]?.price ?? 100;
    const estPrice = input.limitPrice ?? input.stopPrice ?? price;
    return { estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * estPrice, alerts: [], raw: { alpaca: true } };
  }

  async placeEquityOrder(input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> {
    const fallbackFn = async () => {
      try {
        const orderOptions: Record<string, unknown> = {
          symbol: input.symbol,
          side: input.side,
          type: input.type,
          time_in_force: input.timeInForce === "gfd" ? "day" : "gtc",
          client_order_id: input.refId
        };

        if (input.quantity) {
          orderOptions.qty = input.quantity;
        } else if (input.dollarAmount) {
          orderOptions.notional = input.dollarAmount;
        }

        if (input.limitPrice) orderOptions.limit_price = input.limitPrice;
        if (input.stopPrice) orderOptions.stop_price = input.stopPrice;
        if (input.marketHours === "extended_hours") orderOptions.extended_hours = true;

        const raw = await this.alpaca.createOrder(orderOptions);
        return {
          orderId: raw.id,
          refId: input.refId,
          state: raw.status,
          filledQuantity: optionalNumber(raw.filled_qty),
          averagePrice: optionalNumber(raw.filled_avg_price),
          raw
        };
      } catch (error: unknown) {
        throw new Error(`Alpaca order failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    if (!this.isMcp || !this.mcpUrl) {
      return fallbackFn();
    }

    const toolName = input.type === "limit"
      ? "place_limit_order"
      : (input.type === "stop_market" || input.type === "stop_limit")
        ? "place_stop_order"
        : "place_market_order";

    const orderArgs: Record<string, any> = {
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      time_in_force: input.timeInForce === "gfd" ? "day" : "gtc",
      client_order_id: input.refId
    };
    if (input.quantity) orderArgs.qty = String(input.quantity);
    else if (input.dollarAmount) orderArgs.notional = String(input.dollarAmount);

    if (input.limitPrice) orderArgs.limit_price = String(input.limitPrice);
    if (input.stopPrice) orderArgs.stop_price = String(input.stopPrice);

    return this.callMcp<any>(toolName, orderArgs, fallbackFn).then((res: any) => {
      if (res && res.id) {
        return {
          orderId: res.id,
          refId: input.refId,
          state: res.status,
          filledQuantity: optionalNumber(res.filled_qty),
          averagePrice: optionalNumber(res.filled_avg_price),
          raw: res
        };
      }
      return res;
    });
  }

  async cancelEquityOrder(accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    return this.callMcp<any>("cancel_order", { order_id: orderId }, async () => {
      await this.alpaca.cancelOrder(orderId);
      return { orderId, refId: crypto.randomUUID(), state: "cancel_requested", raw: {} };
    }).then((res: any) => {
      if (res && typeof res === "object") {
        return { orderId, refId: crypto.randomUUID(), state: "cancel_requested", raw: res };
      }
      return res;
    });
  }
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function number(value: unknown): number {
  return optionalNumber(value) ?? 0;
}

function optionalIso(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
