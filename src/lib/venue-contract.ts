/**
 * Venue contract — what THIS connected account can actually do.
 *
 * Capabilities come from the broker (live getAccounts when possible) merged with
 * a per-broker known-limits profile.  Policy flags (shortSellingEnabled) can only
 * NARROW the contract, never widen it past the venue.
 *
 * The Green/Red LLM paths must derive their schema + prose from this object so we
 * never spend tokens debating a short, option, session, or order type the account
 * cannot place.  Place-time fail-closed is the last line, not the first.
 */

import type {
  AccountCapabilities,
  ConnectedAccount,
  MarketHours,
  OrderSide,
  OrderType,
  TradingPolicy
} from "./types";
import type { ExecutionAccount } from "./execution-mode";
import { resolveSourceBool } from "./source-settings";

const ALL_ORDER_TYPES: OrderType[] = ["market", "limit", "stop_market", "stop_limit"];
const REGULAR_ONLY: MarketHours[] = ["regular_hours"];
const REGULAR_AND_EXTENDED: MarketHours[] = ["regular_hours", "extended_hours"];
const ALL_SESSIONS: MarketHours[] = ["regular_hours", "extended_hours", "all_day_hours"];

export interface VenueContract {
  broker: ConnectedAccount["broker"] | "none";
  brokerLabel: string;
  sides: OrderSide[];
  orderTypes: OrderType[];
  marketHours: MarketHours[];
  fractional: boolean;
  trailingStops: boolean;
  nativeBrackets: boolean;
  optionsTrading: boolean;
  optionsOrders: boolean;
  minShareQuantity: number;
  minOrderNotional?: number;
  positionIdCloses: boolean;
  /** One-line facts for the LLM.  Never include a capability the schema already omits. */
  promptLines: string[];
}

export function emptyCapabilities(over: Partial<AccountCapabilities> = {}): AccountCapabilities {
  return {
    equityTrading: true,
    shortSelling: false,
    optionsTrading: false,
    futuresTrading: false,
    cryptoTrading: false,
    marginEnabled: false,
    accountType: "brokerage",
    fractional: false,
    extendedHours: false,
    overnightHours: false,
    trailingStops: false,
    nativeBrackets: false,
    optionsOrders: false,
    orderTypes: ["market", "limit"],
    marketHours: REGULAR_ONLY,
    ...over
  };
}

/**
 * Official, verified venue limits (2026-08).  Live getAccounts may override
 * shortSelling / optionsLevel / accountType / marginEnabled.  It must not invent
 * a short or option-order path the public API does not expose.
 */
export function knownBrokerLimits(broker: ConnectedAccount["broker"] | undefined): Partial<AccountCapabilities> {
  switch (broker) {
    case "alpaca":
    case "alpaca-mcp":
      return {
        equityTrading: true,
        optionsTrading: false,
        optionsOrders: false,
        fractional: true,
        extendedHours: true,
        overnightHours: false,
        trailingStops: true,
        nativeBrackets: true,
        orderTypes: ALL_ORDER_TYPES,
        marketHours: REGULAR_AND_EXTENDED,
        futuresTrading: false,
        cryptoTrading: false
      };
    case "robinhood":
      // Live MCP: place/review side enum is buy|sell only.  "no short sells" on fractionals
      // and no short side.  Options: exercise existing longs, no place-option in this app.
      return {
        equityTrading: true,
        shortSelling: false,
        optionsOrders: false,
        fractional: true,
        extendedHours: true,
        overnightHours: true,
        trailingStops: false,
        nativeBrackets: false,
        orderTypes: ALL_ORDER_TYPES,
        marketHours: ALL_SESSIONS,
        futuresTrading: false,
        cryptoTrading: false
      };
    case "tradier":
      return {
        equityTrading: true,
        optionsOrders: false,
        fractional: false,
        extendedHours: true,
        overnightHours: false,
        trailingStops: false,
        nativeBrackets: true,
        orderTypes: ALL_ORDER_TYPES,
        marketHours: REGULAR_AND_EXTENDED,
        minShareQuantity: 1,
        futuresTrading: false,
        cryptoTrading: false
      };
    case "etoro":
      // US entity: long real stocks/ETFs.  Shorts are CFD mechanics eToro USA does not offer.
      // No options in OpenAPI v1.342.  No extended hours.  Close is position-id based.
      return {
        equityTrading: true,
        shortSelling: false,
        optionsTrading: false,
        optionsOrders: false,
        fractional: true,
        extendedHours: false,
        overnightHours: false,
        trailingStops: false,
        nativeBrackets: false,
        orderTypes: ["market", "limit"],
        marketHours: REGULAR_ONLY,
        positionIdCloses: true,
        futuresTrading: false,
        cryptoTrading: false,
        marginEnabled: false
      };
    case "public":
      // Individual API: shorts via SELL+OPEN / BUY+CLOSE.  Options exist at the venue
      // but this app's proposal schema is equities-only (optionsOrders false).
      return {
        equityTrading: true,
        shortSelling: true,
        optionsOrders: false,
        fractional: true,
        extendedHours: true,
        overnightHours: true,
        trailingStops: false,
        nativeBrackets: false,
        orderTypes: ALL_ORDER_TYPES,
        marketHours: ALL_SESSIONS,
        minOrderNotional: 5,
        futuresTrading: false,
        cryptoTrading: false
      };
    case "webull":
      // Official OpenAPI: SHORT, trail, brackets, fractional, extended + overnight.
      // Options exist at the venue; ST proposal schema is still equities-only.
      return {
        equityTrading: true,
        shortSelling: true,
        optionsOrders: false,
        fractional: true,
        extendedHours: true,
        overnightHours: true,
        trailingStops: true,
        nativeBrackets: true,
        orderTypes: ALL_ORDER_TYPES,
        marketHours: ALL_SESSIONS,
        futuresTrading: false,
        cryptoTrading: false
      };
    case "test":
      return {
        equityTrading: true,
        shortSelling: true,
        fractional: true,
        extendedHours: true,
        overnightHours: true,
        trailingStops: true,
        nativeBrackets: true,
        orderTypes: ALL_ORDER_TYPES,
        marketHours: ALL_SESSIONS
      };
    default:
      return { equityTrading: true, shortSelling: false, optionsOrders: false };
  }
}

export function mergeAccountCapabilities(
  broker: ConnectedAccount["broker"] | undefined,
  live?: AccountCapabilities
): AccountCapabilities {
  const known = knownBrokerLimits(broker);
  const base = emptyCapabilities(known);
  if (!live) return base;
  return {
    ...base,
    ...live,
    // Known venue facts win when live omitted the field (legacy rows stored only booleans).
    fractional: live.fractional ?? base.fractional,
    extendedHours: live.extendedHours ?? base.extendedHours,
    overnightHours: live.overnightHours ?? base.overnightHours,
    trailingStops: live.trailingStops ?? base.trailingStops,
    nativeBrackets: live.nativeBrackets ?? base.nativeBrackets,
    orderTypes: live.orderTypes ?? base.orderTypes,
    marketHours: live.marketHours ?? base.marketHours,
    minShareQuantity: live.minShareQuantity ?? base.minShareQuantity,
    minOrderNotional: live.minOrderNotional ?? base.minOrderNotional,
    positionIdCloses: live.positionIdCloses ?? base.positionIdCloses,
    // Never promote a short/option-order the venue profile forbids, even if a stale row said true.
    shortSelling: known.shortSelling === false ? false : (live.shortSelling ?? base.shortSelling),
    optionsOrders: known.optionsOrders === false ? false : (live.optionsOrders ?? base.optionsOrders)
  };
}

export function brokerDisplayLabel(broker: ConnectedAccount["broker"] | undefined): string {
  switch (broker) {
    case "alpaca":
    case "alpaca-mcp":
      return "Alpaca";
    case "robinhood":
      return "Robinhood";
    case "tradier":
      return "Tradier";
    case "etoro":
      return "eToro";
    case "public":
      return "Public";
    case "webull":
      return "Webull";
    case "test":
      return "Test";
    default:
      return "broker";
  }
}

export function deriveVenueContract(
  policy: Pick<TradingPolicy, "shortSellingEnabled">,
  account?: ExecutionAccount | Pick<ConnectedAccount, "broker" | "capabilities">
): VenueContract {
  const broker = account?.broker ?? "none";
  const caps = mergeAccountCapabilities(account?.broker, account?.capabilities);
  const publicParked = broker === "public" && !resolveSourceBool("PUBLIC_EXECUTION_ENABLED");
  const shortAllowed = !publicParked && policy.shortSellingEnabled === true && caps.shortSelling === true;
  const sides: OrderSide[] = publicParked ? [] : shortAllowed ? ["buy", "sell", "short", "cover"] : ["buy", "sell"];
  const orderTypes = (caps.orderTypes?.length ? caps.orderTypes : ["market", "limit"]) as OrderType[];
  const marketHours = resolveSessions(caps);
  const promptLines = buildPromptLines({
    brokerLabel: brokerDisplayLabel(account?.broker),
    shortAllowed,
    caps,
    orderTypes,
    marketHours
  });
  if (publicParked) {
    promptLines.unshift(
      "Public.com execution is parked until the account is funded.  Do not propose any orders for this venue."
    );
  }
  return {
    broker,
    brokerLabel: brokerDisplayLabel(account?.broker),
    sides,
    orderTypes,
    marketHours,
    fractional: caps.fractional === true,
    trailingStops: caps.trailingStops === true,
    nativeBrackets: caps.nativeBrackets === true,
    optionsTrading: caps.optionsTrading === true,
    optionsOrders: caps.optionsOrders === true,
    minShareQuantity: caps.minShareQuantity ?? (caps.fractional === true ? 0 : 1),
    minOrderNotional: caps.minOrderNotional,
    positionIdCloses: caps.positionIdCloses === true,
    promptLines
  };
}

function resolveSessions(caps: AccountCapabilities): MarketHours[] {
  if (caps.marketHours?.length) return caps.marketHours as MarketHours[];
  const sessions: MarketHours[] = ["regular_hours"];
  if (caps.extendedHours) sessions.push("extended_hours");
  if (caps.overnightHours) sessions.push("all_day_hours");
  return sessions;
}

function buildPromptLines(input: {
  brokerLabel: string;
  shortAllowed: boolean;
  caps: AccountCapabilities;
  orderTypes: OrderType[];
  marketHours: MarketHours[];
}): string[] {
  const lines: string[] = [
    `You are an autonomous equity trading agent for a ${input.brokerLabel} account.`
  ];
  if (input.shortAllowed) {
    lines.push(
      "SHORT SELLING IS ENABLED on this account.  In addition to buy/sell you MAY open SHORT positions (side='short') and close them with side='cover'."
    );
  } else {
    lines.push("SHORT SELLING IS DISABLED on this account.  Propose long-only: side is buy or sell.  Do not propose short or cover.");
  }
  if (!input.caps.optionsOrders) {
    lines.push(
      "OPTIONS ORDERS ARE NOT AVAILABLE on this strategy path.  Do not propose calls, puts, spreads, or option overlays — even as a hedge.  Equities only."
    );
  }
  if (input.caps.fractional !== true) {
    lines.push("Whole shares only.  Do not size an opening below one share.");
  }
  if (input.minOrderNotional != null && input.minOrderNotional > 0) {
    lines.push(`Minimum order notional is ${input.minOrderNotional} in account currency.`);
  }
  if (!input.marketHours.includes("extended_hours") && !input.marketHours.includes("all_day_hours")) {
    lines.push("Regular-hours only.  Do not set marketHours to extended_hours or all_day_hours.");
  } else if (!input.marketHours.includes("all_day_hours")) {
    lines.push("Overnight / 24-hour session is not available.  Regular or extended hours only.");
  }
  if (!input.caps.trailingStops) {
    lines.push("This venue has no native trailing-stop parameter.  Do not request trailPercent.");
  }
  if (!input.caps.nativeBrackets) {
    lines.push("This venue has no native bracket/OTOCO legs.  Protective prices still belong in bracketStopLoss / stopPlan; the app will hold them.");
  }
  if (input.caps.positionIdCloses) {
    lines.push("Sells close an existing lot at this venue.  Never use sell to open a short.");
  }
  lines.push(`Allowed equity order types: ${input.orderTypes.join(", ")}.`);
  return lines;
}
