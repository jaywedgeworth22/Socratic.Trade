import crypto from "crypto";
import type {
  AccountCapabilities,
  BrokerageAccount,
  BrokerQuote,
  EquityOrder,
  EquityPosition,
  ExecutedOrder,
  OrderSide,
  OrderType,
  Portfolio,
  ReviewedOrder,
  BrokerGateway,
  EquityOrderInput
} from "./types";
import { normalizeSymbol } from "./money";
import { getActiveConnectedAccount, getConnectedAccount } from "./db";
import { logApiHealth } from "./db-health";
import { recordProviderCall, pushBrokerBalance } from "./usage-monitor-push";
import { fetchDailyOHLC } from "./history";
// Reuse Alpaca's keyless-Yahoo quote floor and the shared pre-trade notional semantics verbatim —
// they are broker-agnostic helpers exported from ./alpaca (no Alpaca SDK behavior involved).
import { fillMissingQuotesWithClose, estimateReviewNotional } from "./alpaca";

/**
 * Tradier broker gateway. Hand-rolled REST (single Bearer token, no SDK), mirroring the Alpaca
 * adapter's structure. Environment is chosen explicitly at connect time — a sandbox token only
 * authenticates against sandbox.tradier.com and a production token only against api.tradier.com —
 * so the base URL is DERIVED from environment and the two can never cross. A misconfigured pairing
 * (e.g. a sandbox token stored as "live") 401s at the wrong host and throws before any order,
 * failing closed.
 *
 * Tradier is WHOLE-SHARE only (no fractional equities, no notional field), natively accepts the
 * 4-value order side (buy/sell/sell_short/buy_to_cover) so OrderSide maps DIRECTLY rather than
 * through toBrokerSide, and uses BRK.B dot notation which is already our canonical form (no
 * toAlpacaSymbol conversion on the wire). v1 uses synthetic stops (no OTOCO brackets) because
 * strategy.ts gates broker brackets to Alpaca.
 */
export function getTradierGateway(userId: string = "local", connectedAccountId?: string): BrokerGateway {
  return new TradierBrokerGateway(userId, connectedAccountId);
}

// Tradier envelopes wrap collections as { orders: { order: [...] } }, collapse a lone element to a
// bare object { orders: { order: {...} } }, and report empty as null or the string "null". Normalize
// any of those to a plain array so per-row mapping is uniform.
function arr<T>(x: unknown): T[] {
  if (x === null || x === undefined) return [];
  if (typeof x === "string") return x.trim().toLowerCase() === "null" ? [] : [];
  if (Array.isArray(x)) return x as T[];
  return [x as T];
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function number(value: unknown): number {
  return optionalNumber(value) ?? 0;
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return String(value);
}

function optionalIso(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

// Whether the current US/Eastern clock is before the 09:30 open (pre-market) vs after (after-hours).
// Used to pick Tradier's extended session duration ("pre" vs "post") for an extended-hours order.
function etHourBefore0930(): boolean {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return hour * 60 + minute < 9 * 60 + 30;
  } catch {
    return false; // default to after-hours ("post") if the clock lookup fails
  }
}

// OrderSide -> Tradier `side` (WRITE). DIRECT 4-value map (not toBrokerSide): Tradier natively
// accepts sell_short/buy_to_cover, so this preserves the explicit short/cover intent the broker
// would otherwise have to infer.
function mapTradierSideWrite(side: OrderSide): string {
  switch (side) {
    case "buy":
      return "buy";
    case "sell":
      return "sell";
    case "short":
      return "sell_short";
    case "cover":
      return "buy_to_cover";
  }
}

// Tradier `o.side` -> OrderSide (READ-BACK).
function mapTradierSideRead(raw: unknown): OrderSide {
  switch (String(raw)) {
    case "buy":
      return "buy";
    case "sell":
      return "sell";
    case "sell_short":
      return "short";
    case "buy_to_cover":
      return "cover";
    default:
      return "buy";
  }
}

// OrderType -> Tradier `type` (WRITE). Tradier's wire word for a stop-market is "stop".
function mapTradierTypeWrite(type: OrderType): string {
  return type === "stop_market" ? "stop" : type;
}

// Tradier `o.type` -> OrderType (READ-BACK).
function mapTradierTypeRead(raw: unknown): OrderType {
  switch (String(raw)) {
    case "market":
      return "market";
    case "limit":
      return "limit";
    case "stop":
      return "stop_market";
    case "stop_limit":
      return "stop_limit";
    default:
      return "market";
  }
}

// EquityOrderInput -> Tradier `duration`. Extended-hours is expressed through the duration
// ("pre"/"post"), not a separate flag; Tradier only fills an extended-session order as a LIMIT, so
// only a limit order gets the pre/post session — anything else falls back to the regular-session TIF.
function durationFor(input: { marketHours?: EquityOrderInput["marketHours"]; type?: OrderType; timeInForce?: EquityOrderInput["timeInForce"] }): string {
  if (input.marketHours === "extended_hours" && input.type === "limit") {
    return etHourBefore0930() ? "pre" : "post";
  }
  return input.timeInForce === "gfd" ? "day" : "gtc";
}

// Sanitize a refId into Tradier's `tag` field: alnum + dash, <= 255 chars.
function sanitizeTag(refId: string): string {
  return String(refId).replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 255);
}

// Tradier's GET /v1/user/profile account object -> AccountCapabilities. False-by-default discipline:
// only set a capability true on a field Tradier explicitly confirms.
function capsFromProfile(account: Record<string, unknown>): AccountCapabilities {
  const type = String(account.type ?? "").toLowerCase();
  const classification = String(account.classification ?? "").toLowerCase();
  const isMargin = type === "margin";
  const rawLevel = optionalNumber(account.option_level);
  const optionsLevel: AccountCapabilities["optionsLevel"] =
    rawLevel !== undefined && rawLevel >= 0 && rawLevel <= 4 ? (Math.trunc(rawLevel) as 0 | 1 | 2 | 3 | 4) : undefined;
  let accountType: AccountCapabilities["accountType"] = "brokerage";
  if (classification.includes("roth")) accountType = "roth_ira";
  else if (classification.includes("ira") || classification.includes("traditional") || classification.includes("rollover")) {
    accountType = "traditional_ira";
  }
  return {
    equityTrading: true,
    shortSelling: isMargin,
    optionsTrading: optionsLevel !== undefined ? optionsLevel > 0 : false,
    optionsLevel,
    futuresTrading: false,
    cryptoTrading: false,
    marginEnabled: isMargin,
    accountType
  };
}

class TradierBrokerGateway implements BrokerGateway {
  private token: string;
  private baseUrl: string;
  private label: string;
  private environment: "paper" | "live";
  private accountNumber?: string;
  private keySource: string;

  constructor(private userId: string, connectedAccountId?: string) {
    const targeted = connectedAccountId ? getConnectedAccount(connectedAccountId, userId) : undefined;
    const active = getActiveConnectedAccount(userId);
    const acct = targeted ?? active;
    const keys = acct?.broker === "tradier" ? acct : undefined;

    // No operator env fallback: a Tradier token is a single owned Bearer credential (unlike Alpaca's
    // per-user tier with an operator env floor). Resolve ONLY from a stored connected-account row for
    // THIS user, and fail loudly otherwise so a non-owner never trades on someone else's token.
    if (!keys) {
      throw new Error("No Tradier account connected.");
    }
    const token = keys.apiKey?.trim();
    if (!token) {
      throw new Error(
        `Tradier access token is missing for ${keys.label}. Open Settings -> Accounts and re-save the token.`
      );
    }
    this.token = token;
    this.keySource = "user";
    this.environment = keys.environment;

    // Base URL is DERIVED from environment so a sandbox token can only ever reach sandbox and a
    // production token only api.tradier.com — the two venues can never be crossed.
    let baseUrl = keys.baseUrl?.trim() || (this.environment === "live" ? "https://api.tradier.com/v1" : "https://sandbox.tradier.com/v1");
    baseUrl = baseUrl.replace(/\/+$/, "");
    if (!/\/v1$/i.test(baseUrl)) baseUrl = `${baseUrl}/v1`;
    this.baseUrl = baseUrl;

    this.label = keys.label || (this.environment === "live" ? "Tradier Brokerage" : "Tradier Sandbox");
    this.accountNumber = keys.accountNumber;
  }

  // Raw Tradier REST call. Bearer auth + JSON accept; POST/PUT bodies are form-encoded (Tradier's
  // trading API takes application/x-www-form-urlencoded, not JSON). Throws a joined message on a
  // non-2xx response or a parsed Tradier error envelope ({ errors: { error: [...] } }).
  private async request<T>(
    method: string,
    path: string,
    opts: { form?: Record<string, string | number | undefined>; query?: Record<string, string | number | undefined> } = {}
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null && v !== "") qs.append(k, String(v));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json"
    };
    let body: string | undefined;
    if (method === "POST" || method === "PUT") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form ?? {})) {
        if (v !== undefined && v !== null && v !== "") form.append(k, String(v));
      }
      body = form.toString();
    }
    const response = await fetch(url, { method, headers, body });
    let parsed: unknown = undefined;
    const text = await response.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      throw new Error(`Tradier HTTP ${response.status}: ${formatTradierError(parsed) || text || response.statusText}`);
    }
    // Tradier returns 200 with an { errors: { error: [...] } } envelope for validation failures.
    if (parsed && typeof parsed === "object" && "errors" in (parsed as Record<string, unknown>)) {
      const msg = formatTradierError(parsed);
      if (msg) throw new Error(msg);
    }
    return parsed as T;
  }

  // Wrap a call for the admin connections-health page ("tradier-broker") + provider-usage telemetry,
  // mirroring Alpaca's trackHealth. logApiHealth swallows its own errors; the broker call is never
  // affected by a logging failure.
  private async trackHealth<T>(fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      logApiHealth({ service: "tradier-broker", ok: true, latencyMs: Date.now() - start, keySource: this.keySource, userId: this.userId });
      recordProviderCall("tradier", { service: "broker", ok: true });
      return result;
    } catch (err) {
      logApiHealth({
        service: "tradier-broker",
        ok: false,
        latencyMs: Date.now() - start,
        errorText: err instanceof Error ? err.message : String(err),
        keySource: this.keySource,
        userId: this.userId
      });
      recordProviderCall("tradier", { service: "broker", ok: false });
      throw err;
    }
  }

  async getAccounts(): Promise<BrokerageAccount[]> {
    return this.trackHealth(async () => {
      const body = await this.request<{ profile?: { account?: unknown } }>("GET", "/user/profile");
      const accounts = arr<Record<string, unknown>>(body.profile?.account);
      return accounts.map((account) => {
        const accountNumber = String(account.account_number ?? "");
        const type = account.type ? String(account.type) : "";
        return {
          accountNumber,
          label: this.label || `Tradier ${type || "account"}`.trim(),
          agenticAllowed: true,
          capabilities: capsFromProfile(account)
        } satisfies BrokerageAccount;
      });
    });
  }

  async getPortfolio(accountNumber: string): Promise<Portfolio> {
    return this.trackHealth(async () => {
      const body = await this.request<{ balances?: Record<string, unknown> }>("GET", `/accounts/${accountNumber}/balances`);
      const b = body.balances ?? {};
      // Account-Mismatch guard mirroring Alpaca: only flag a GENUINE cross-account mismatch (both
      // present and actually different, ignoring case/whitespace).
      const liveNum = String(b.account_number ?? "").trim();
      const wantNum = String(accountNumber ?? "").trim();
      if (wantNum && liveNum && liveNum.toLowerCase() !== wantNum.toLowerCase()) {
        throw new Error(
          `Account Mismatch: the connected Tradier credentials are for account ${liveNum}, but this profile is configured for ${wantNum}. Update the account number in Settings -> Accounts.`
        );
      }
      const margin = b.margin as Record<string, unknown> | undefined;
      const cashAcct = b.cash as Record<string, unknown> | undefined;
      const totalCash = number(b.total_cash);
      const totalMarketValue = optionalNumber(b.total_equity) ?? number(b.market_value) + totalCash;
      const buyingPower = margin
        ? number(margin.stock_buying_power)
        : cashAcct
          ? number(cashAcct.cash_available)
          : totalCash;
      const result: Portfolio = {
        accountNumber,
        totalMarketValue,
        buyingPower,
        equityMarketValue: number(b.market_value),
        optionMarketValue: number(b.long_option_value ?? b.option_long_value ?? 0),
        cash: totalCash
      };
      pushBrokerBalance({
        provider: "tradier",
        userId: this.userId,
        accountNumber,
        cash: result.cash,
        buyingPower: result.buyingPower,
        equity: result.totalMarketValue
      });
      return result;
    });
  }

  async getEquityPositions(accountNumber: string): Promise<EquityPosition[]> {
    return this.trackHealth(async () => {
      const body = await this.request<{ positions?: { position?: unknown } | string }>("GET", `/accounts/${accountNumber}/positions`);
      const positionsField = typeof body.positions === "object" && body.positions ? (body.positions as Record<string, unknown>).position : undefined;
      const rows = arr<Record<string, unknown>>(positionsField);
      if (rows.length === 0) return [];
      const symbols = rows.map((p) => normalizeSymbol(String(p.symbol)));
      // Tradier position rows carry TOTAL cost_basis and no live market_value — price them via a
      // single batched quote call (fall back to cost basis when a quote is missing).
      const quotes = await this.getEquityQuotes(accountNumber, symbols).catch(() => ({} as Record<string, BrokerQuote>));
      return rows.map((p) => {
        const symbol = normalizeSymbol(String(p.symbol));
        const quantity = number(p.quantity);
        const totalCost = number(p.cost_basis);
        const averageCost = quantity !== 0 ? totalCost / quantity : 0;
        const price = quotes[symbol]?.price;
        const marketValue = price && price > 0 ? quantity * price : quantity * averageCost;
        return {
          symbol,
          quantity,
          averageCost,
          marketValue,
          sector: undefined,
          industry: undefined
        } satisfies EquityPosition;
      });
    });
  }

  async getEquityOrders(accountNumber: string): Promise<EquityOrder[]> {
    return this.trackHealth(async () => {
      const all: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      for (let page = 1; page <= 50; page++) {
        const body = await this.request<{ orders?: { order?: unknown } | string }>("GET", `/accounts/${accountNumber}/orders`, {
          query: { page, includeTags: "true" }
        });
        const ordersField = typeof body.orders === "object" && body.orders ? (body.orders as Record<string, unknown>).order : undefined;
        const rows = arr<Record<string, unknown>>(ordersField);
        if (rows.length === 0) break;
        let added = 0;
        for (const o of rows) {
          const id = String(o.id);
          if (seen.has(id)) continue;
          seen.add(id);
          all.push(o);
          added += 1;
        }
        if (added === 0) break;
      }
      return all.map((o) => mapTradierOrder(o));
    });
  }

  async getEquityQuotes(accountNumber: string, symbols: string[]): Promise<Record<string, BrokerQuote>> {
    const aliasesByCanonical = new Map<string, Set<string>>();
    for (const rawSymbol of symbols) {
      const requested = normalizeSymbol(rawSymbol);
      if (!requested) continue;
      // Tradier uses BRK.B dot notation, which is NOT our canonical (hyphenated) form; canonicalize
      // via normalizeSymbol only (no toAlpacaSymbol) and convert to dots on the wire.
      const canonical = requested;
      const aliases = aliasesByCanonical.get(canonical) ?? new Set<string>();
      aliases.add(canonical);
      aliasesByCanonical.set(canonical, aliases);
    }
    const canonicalSymbols = Array.from(aliasesByCanonical.keys());
    const quotes: Record<string, BrokerQuote> = {};
    if (canonicalSymbols.length > 0) {
      try {
        // Tradier equity symbols use dots (BRK.B); our canonical is hyphenated, so convert on the wire.
        const wireSymbols = canonicalSymbols.map((s) => s.replace(/-/g, "."));
        const body = await this.trackHealth(() =>
          this.request<{ quotes?: { quote?: unknown } | string }>("GET", "/markets/quotes", {
            query: { symbols: wireSymbols.join(","), greeks: "false" }
          })
        );
        const quotesField = typeof body.quotes === "object" && body.quotes ? (body.quotes as Record<string, unknown>).quote : undefined;
        for (const q of arr<Record<string, unknown>>(quotesField)) {
          const symbol = normalizeSymbol(String(q.symbol)).replace(/\./g, "-");
          const last = optionalNumber(q.last);
          const close = optionalNumber(q.close);
          const ask = optionalNumber(q.ask);
          const bid = optionalNumber(q.bid);
          quotes[symbol] = {
            symbol,
            price: last ?? close ?? ask ?? bid ?? 0,
            bid,
            ask,
            volume: optionalNumber(q.volume),
            asOf: optionalIso(q.trade_date ?? q.bid_date),
            provider: "tradier"
          };
        }
      } catch (error) {
        console.warn(`[tradier] getEquityQuotes failed for ${canonicalSymbols.join(",")}:`, error instanceof Error ? error.message : error);
      }
    }
    // Keyless Yahoo daily-close floor for any symbol Tradier left unpriced — identical to Alpaca.
    await fillMissingQuotesWithClose(quotes, canonicalSymbols, async (symbol) => {
      const bars = await fetchDailyOHLC(symbol, Date.now(), this.userId);
      const lastBar = bars && bars.length ? bars[bars.length - 1] : undefined;
      return lastBar && typeof lastBar.close === "number" ? { price: lastBar.close, asOf: lastBar.time != null ? String(lastBar.time) : undefined } : undefined;
    });
    for (const [canonical, aliases] of aliasesByCanonical) {
      const quote = quotes[canonical];
      if (!quote) continue;
      for (const alias of aliases) {
        if (!quotes[alias]) quotes[alias] = { ...quote, symbol: alias };
      }
    }
    return quotes;
  }

  async getEquityTradability(accountNumber: string, symbols: string[]) {
    // v1 stub mirroring Alpaca, but fractional MUST be false — Tradier has no fractional equities,
    // which also forces whole-share sizing upstream.
    return Object.fromEntries(symbols.map((symbol) => [normalizeSymbol(symbol), { tradable: true, fractional: false }]));
  }

  async reviewEquityOrder(input: EquityOrderInput): Promise<ReviewedOrder> {
    // v1 self-computes (no Tradier preview call) using the shared over-cap/exit notional semantics.
    const quotes = await this.getEquityQuotes(input.accountNumber, [input.symbol]);
    const quotePrice = quotes[normalizeSymbol(input.symbol)]?.price;
    const { estimatedNotional, alerts } = estimateReviewNotional(input, quotePrice);
    return { estimatedNotional, alerts, raw: { tradier: true } };
  }

  async placeEquityOrder(input: EquityOrderInput & { refId: string }): Promise<ExecutedOrder> {
    // WHOLE-SHARE resolution: Tradier has no notional field, so a dollar order is floored into
    // shares at an anchor price. Never default to 1 — a $500 order must not become 500 shares — and
    // throw when it can't make a whole share.
    let shares = input.quantity != null ? input.quantity : undefined;
    if (shares == null && input.dollarAmount) {
      let anchorPrice = input.limitPrice ?? input.referencePrice;
      if (anchorPrice == null || !(anchorPrice > 0)) {
        const quotes = await this.getEquityQuotes(input.accountNumber, [input.symbol]);
        anchorPrice = quotes[normalizeSymbol(input.symbol)]?.price;
      }
      if (anchorPrice && anchorPrice > 0) {
        shares = input.dollarAmount / anchorPrice;
      }
    }
    const wholeQty = shares != null ? Math.floor(shares) : NaN;
    if (!(wholeQty >= 1)) {
      throw new Error("Tradier order too small for a whole share (or no positive price to size a dollar order).");
    }

    // v1 IGNORES bracketTakeProfit/bracketStopLoss: strategy.ts never sets them for Tradier
    // (brokerSupportsBrackets is Alpaca-only), and protection comes from the synthetic-stop monitor.
    // Native Tradier OTOCO brackets are a follow-up.
    const form: Record<string, string | number | undefined> = {
      class: "equity",
      symbol: normalizeSymbol(input.symbol).replace(/-/g, "."),
      side: mapTradierSideWrite(input.side), // DIRECT 4-value map (short->sell_short, cover->buy_to_cover)
      type: mapTradierTypeWrite(input.type), // stop_market->stop
      quantity: String(wholeQty),
      duration: durationFor(input),
      tag: sanitizeTag(input.refId)
    };
    if (input.limitPrice != null) form.price = input.limitPrice;
    if (input.stopPrice != null) form.stop = input.stopPrice;

    let body: { order?: Record<string, unknown> };
    try {
      body = await this.trackHealth(() =>
        this.request<{ order?: Record<string, unknown> }>("POST", `/accounts/${input.accountNumber}/orders`, { form })
      );
    } catch (error) {
      throw new Error(`Tradier order failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const o = body.order ?? {};
    const id = o.id;
    // ExecutedOrder MUST carry a usable orderId or the reconciliation sweep can't match it —
    // String(undefined) must never silently become the literal "undefined".
    if (id === undefined || id === null || id === "") {
      throw new Error(`Tradier order failed: response had no order id: ${JSON.stringify(body)}`);
    }
    // Tradier returns status "ok" on accept (request-accepted, not a real order-state word) —
    // normalize to "pending" so isLiveOrderState recognizes it as resting; a real terminal status
    // (e.g. "rejected") passes through verbatim so isRejectedOrCanceledState still catches a
    // synchronous decline.
    const raw = String(o.status ?? "");
    const state = raw && raw.toLowerCase() !== "ok" ? raw : "pending";
    return {
      orderId: String(id),
      refId: input.refId,
      state,
      filledQuantity: undefined,
      averagePrice: undefined,
      raw: body
    };
  }

  async cancelEquityOrder(accountNumber: string, orderId: string): Promise<ExecutedOrder> {
    const body = await this.trackHealth(() =>
      this.request<{ order?: Record<string, unknown> }>("DELETE", `/accounts/${accountNumber}/orders/${orderId}`)
    );
    return {
      orderId,
      refId: crypto.randomUUID(),
      state: String(body.order?.status ?? "cancel_requested"),
      raw: body
    };
  }
}

// Map a raw Tradier order object to our EquityOrder. State is stored RAW (broker-side.ts normalizes).
export function mapTradierOrder(o: Record<string, unknown>): EquityOrder {
  return {
    id: String(o.id),
    symbol: normalizeSymbol(String(o.symbol)).replace(/\./g, "-"),
    side: mapTradierSideRead(o.side),
    type: mapTradierTypeRead(o.type),
    state: String(o.status),
    quantity: optionalNumber(o.quantity),
    filledQuantity: optionalNumber(o.exec_quantity),
    averagePrice: optionalNumber(o.avg_fill_price),
    limitPrice: optionalNumber(o.price),
    stopPrice: optionalNumber(o.stop_price),
    timeInForce: optionalString(o.duration),
    createdAt: String(o.create_date),
    updatedAt: optionalString(o.transaction_date),
    clientOrderId: optionalString(o.tag),
    placedAgent: "tradier"
  };
}

// Join a Tradier error envelope ({ errors: { error: [...] | "msg" } }) into a single message.
function formatTradierError(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  const errors = (parsed as Record<string, unknown>).errors;
  if (!errors) return "";
  if (typeof errors === "string") return errors;
  if (typeof errors === "object") {
    const err = (errors as Record<string, unknown>).error;
    if (Array.isArray(err)) return err.map((e) => String(e)).join("; ");
    if (err != null) return String(err);
  }
  return "";
}
