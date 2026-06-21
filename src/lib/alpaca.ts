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

  constructor(userId: string) {
    const activeAccount = getActiveConnectedAccount(userId);
    const accountKeys = activeAccount?.broker === "alpaca" ? activeAccount : undefined;
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
    if (baseUrl) {
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

    if (baseUrl) {
      options.baseUrl = baseUrl;
    }

    this.alpaca = new Alpaca(options);
  }


  async getAccounts(): Promise<BrokerageAccount[]> {
    const account = await this.alpaca.getAccount();
    // Alpaca returns shorting_enabled (boolean) and account_type ("MARGIN" | "CASH").
    const shortSelling = Boolean(account.shorting_enabled);
    const marginEnabled = shortSelling || String(account.account_type ?? "").toUpperCase() === "MARGIN";
    const capabilities: AccountCapabilities = {
      equityTrading: true,
      shortSelling,
      optionsTrading: false, // Alpaca REST v2 does not include equity options
      futuresTrading: false,
      cryptoTrading: false,
      marginEnabled,
      accountType: "brokerage"
    };
    return [
      {
        accountNumber: account.account_number,
        label: this.label,
        agenticAllowed: true,
        capabilities
      }
    ];
  }

  async getPortfolio(accountNumber: string): Promise<Portfolio> {
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
  }

  async getEquityPositions(accountNumber: string): Promise<EquityPosition[]> {
    const positions = await this.alpaca.getPositions();
    return positions.map((p: Record<string, unknown>) => ({
      symbol: normalizeSymbol(String(p.symbol)),
      quantity: number(p.qty),
      averageCost: number(p.avg_entry_price),
      marketValue: number(p.market_value),
      sector: undefined,
      industry: undefined
    }));
  }

  async getEquityOrders(accountNumber: string): Promise<EquityOrder[]> {
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
      placedAgent: "alpaca"
    }));
  }

  async getEquityQuotes(accountNumber: string, symbols: string[]): Promise<Record<string, BrokerQuote>> {
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
          price: ask ?? bid ?? 0, // Ask price or bid price fallback
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
  }

  async cancelEquityOrder(accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    await this.alpaca.cancelOrder(orderId);
    return { orderId, refId: crypto.randomUUID(), state: "cancel_requested", raw: {} };
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
