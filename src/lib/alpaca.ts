import Alpaca from "@alpacahq/alpaca-trade-api";
import crypto from "crypto";
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
import { normalizeSymbol } from "./money";
import { getActiveConnectedAccount, getUserApiKey } from "./db";

export function getAlpacaGateway(userId: string = "local"): BrokerGateway {
  return new AlpacaBrokerGateway(userId);
}

class AlpacaBrokerGateway implements BrokerGateway {
  private alpaca: Alpaca;

  constructor(userId: string) {
    const activeAccount = getActiveConnectedAccount(userId);
    const accountKeys = activeAccount?.broker === "alpaca" ? activeAccount : undefined;
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
    
    this.alpaca = new Alpaca({
      keyId,
      secretKey,
      paper: accountKeys?.environment !== "live",
      usePolygon: false
    });
  }

  async getAccounts(): Promise<BrokerageAccount[]> {
    const account = await this.alpaca.getAccount();
    return [
      {
        accountNumber: account.account_number,
        label: "Alpaca Paper",
        agenticAllowed: true
      }
    ];
  }

  async getPortfolio(accountNumber: string): Promise<Portfolio> {
    const account = await this.alpaca.getAccount();
    if (account.account_number !== accountNumber) throw new Error("Account mismatch");
    return {
      accountNumber,
      totalMarketValue: Number(account.portfolio_value),
      buyingPower: Number(account.buying_power),
      equityMarketValue: Number(account.equity) - Number(account.cash),
      optionMarketValue: 0,
      cash: Number(account.cash)
    };
  }

  async getEquityPositions(accountNumber: string): Promise<EquityPosition[]> {
    const positions = await this.alpaca.getPositions();
    return positions.map((p: any) => ({
      symbol: normalizeSymbol(p.symbol),
      quantity: Number(p.qty),
      averageCost: Number(p.avg_entry_price),
      marketValue: Number(p.market_value),
      sector: undefined,
      industry: undefined
    }));
  }

  async getEquityOrders(accountNumber: string): Promise<EquityOrder[]> {
    const orders = await this.alpaca.getOrders({ status: "all" } as any);
    return orders.map((o: any) => ({
      id: String(o.id),
      symbol: normalizeSymbol(o.symbol),
      side: o.side as OrderSide,
      type: o.type as OrderType,
      state: String(o.status),
      quantity: o.qty ? Number(o.qty) : undefined,
      dollarAmount: o.notional ? Number(o.notional) : undefined,
      filledQuantity: o.filled_qty ? Number(o.filled_qty) : undefined,
      averagePrice: o.filled_avg_price ? Number(o.filled_avg_price) : undefined,
      createdAt: String(o.created_at),
      updatedAt: String(o.updated_at),
      placedAgent: "alpaca"
    }));
  }

  async getEquityQuotes(accountNumber: string, symbols: string[]): Promise<Record<string, BrokerQuote>> {
    const normalizedSymbols = symbols.map(normalizeSymbol);
    try {
      const response = await this.alpaca.getLatestQuotes(normalizedSymbols);
      const quotes: Record<string, BrokerQuote> = {};
      
      for (const [symbol, q] of Object.entries(response)) {
        const anyQ = q as any;
        quotes[symbol] = {
          symbol,
          price: anyQ.ap || anyQ.bp || 0, // Ask price or bid price fallback
          bid: anyQ.bp,
          ask: anyQ.ap,
          asOf: new Date(anyQ.t).toISOString(),
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
      const orderOptions: any = {
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
        filledQuantity: raw.filled_qty ? Number(raw.filled_qty) : undefined,
        averagePrice: raw.filled_avg_price ? Number(raw.filled_avg_price) : undefined,
        raw
      };
    } catch (error: any) {
      throw new Error(`Alpaca order failed: ${error.message}`);
    }
  }

  async cancelEquityOrder(accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    await this.alpaca.cancelOrder(orderId);
    return { orderId, refId: crypto.randomUUID(), state: "cancel_requested", raw: { mock: false } };
  }
}
