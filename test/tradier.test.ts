// Tradier broker-adapter unit tests. global.fetch is stubbed to canned Tradier REST envelopes —
// no network. Each test uses a per-run temp SQLite DB (never data/app.db) and vi.resetModules() so
// the freshly-seeded connected account is picked up.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const SANDBOX_TOKEN = "tok-sandbox-abc";
const LIVE_TOKEN = "tok-live-xyz";
const ACCT = "VA1234567";

interface FetchRecord {
  url: string;
  method: string;
  authorization: string | null;
  accept: string | null;
  contentType: string | null;
  body: string | null;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-tradier-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Seed an active Tradier connected account for `userId`.
async function seedTradier(opts: { environment?: "paper" | "live"; token?: string; userId?: string; accountNumber?: string } = {}): Promise<void> {
  const { upsertConnectedAccount } = await import("../src/lib/db");
  const environment = opts.environment ?? "paper";
  upsertConnectedAccount({
    id: `trd-${randomUUID()}`,
    userId: opts.userId ?? "local",
    broker: "tradier",
    environment,
    accountNumber: opts.accountNumber ?? ACCT,
    label: environment === "live" ? "Tradier Brokerage" : "Tradier Sandbox",
    apiKey: opts.token ?? (environment === "live" ? LIVE_TOKEN : SANDBOX_TOKEN),
    apiSecret: undefined,
    baseUrl: undefined,
    isActive: true
  });
}

// Install a fetch mock that routes by URL path and records every call. `handlers` maps a substring
// of the path to a JSON response body.
function installFetchMock(handlers: Array<{ match: (url: string, method: string) => boolean; body: unknown; status?: number }>): { records: FetchRecord[] } {
  const records: FetchRecord[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    records.push({
      url: u,
      method,
      authorization: headers.get("authorization"),
      accept: headers.get("accept"),
      contentType: headers.get("content-type"),
      body: typeof init?.body === "string" ? init.body : null
    });
    const handler = handlers.find((h) => h.match(u, method));
    if (!handler) {
      // Yahoo/Stooq fallbacks in the quote floor: 404 so nothing throws.
      return new Response("", { status: 404 });
    }
    return new Response(JSON.stringify(handler.body), {
      status: handler.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  });
  return { records };
}

describe("Tradier adapter — auth + base URL", () => {
  it("sends Bearer auth + JSON accept, and a sandbox row hits sandbox.tradier.com", async () => {
    await seedTradier({ environment: "paper" });
    const { records } = installFetchMock([
      { match: (u) => u.includes("/user/profile"), body: { profile: { account: { account_number: ACCT, type: "margin", classification: "individual" } } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").getAccounts();
    const call = records.find((r) => r.url.includes("/user/profile"))!;
    expect(call.authorization).toBe(`Bearer ${SANDBOX_TOKEN}`);
    expect(call.accept).toBe("application/json");
    expect(call.url).toContain("https://sandbox.tradier.com/v1/user/profile");
  });

  it("a live row hits api.tradier.com", async () => {
    await seedTradier({ environment: "live" });
    const { records } = installFetchMock([
      { match: (u) => u.includes("/user/profile"), body: { profile: { account: { account_number: ACCT, type: "cash", classification: "individual" } } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").getAccounts();
    const call = records.find((r) => r.url.includes("/user/profile"))!;
    expect(call.authorization).toBe(`Bearer ${LIVE_TOKEN}`);
    expect(call.url).toContain("https://api.tradier.com/v1/user/profile");
  });
});

describe("Tradier adapter — side & type mapping (write)", () => {
  async function place(side: "buy" | "sell" | "short" | "cover", type: "market" | "limit" | "stop_market" | "stop_limit" = "market") {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u) => u.includes("/markets/quotes"), body: { quotes: { quote: { symbol: "AAPL", last: 100 } } } },
      { match: (u, m) => u.includes(`/accounts/${ACCT}/orders`) && m === "POST", body: { order: { id: 555, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "AAPL", side, type, quantity: 3,
      timeInForce: "gfd", marketHours: "regular_hours",
      ...(type === "limit" || type === "stop_limit" ? { limitPrice: 101 } : {}),
      ...(type === "stop_market" || type === "stop_limit" ? { stopPrice: 99 } : {}),
      refId: "r1"
    });
    const post = records.find((r) => r.method === "POST" && r.url.includes("/orders"))!;
    return new URLSearchParams(post.body ?? "");
  }

  it("maps buy/sell/short/cover directly to Tradier sides", async () => {
    expect((await place("buy")).get("side")).toBe("buy");
    expect((await place("sell")).get("side")).toBe("sell");
    expect((await place("short")).get("side")).toBe("sell_short");
    expect((await place("cover")).get("side")).toBe("buy_to_cover");
  });

  it("maps stop_market to 'stop' on write; keeps limit/stop_limit", async () => {
    expect((await place("buy", "stop_market")).get("type")).toBe("stop");
    expect((await place("buy", "limit")).get("type")).toBe("limit");
    expect((await place("buy", "stop_limit")).get("type")).toBe("stop_limit");
  });

  it("form-encodes the POST with Content-Type application/x-www-form-urlencoded", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u, m) => u.includes(`/accounts/${ACCT}/orders`) && m === "POST", body: { order: { id: 1, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "AAPL", side: "buy", type: "market", quantity: 1,
      timeInForce: "gfd", marketHours: "regular_hours", refId: "r-form"
    });
    const post = records.find((r) => r.method === "POST")!;
    expect(post.contentType).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(post.body ?? "").get("class")).toBe("equity");
  });
});

describe("Tradier adapter — read-back mapping", () => {
  it("maps sell_short->short, buy_to_cover->cover, stop->stop_market from getEquityOrders", async () => {
    await seedTradier();
    installFetchMock([
      {
        match: (u) => u.includes(`/accounts/${ACCT}/orders`),
        body: { orders: { order: [
          { id: 1, symbol: "AAPL", side: "sell_short", type: "stop", status: "open", quantity: 5, duration: "gtc", create_date: "2026-07-10", stop_price: 90, tag: "abc" },
          { id: 2, symbol: "MSFT", side: "buy_to_cover", type: "limit", status: "pending", quantity: 5, duration: "day", create_date: "2026-07-10", price: 300 }
        ] } }
      }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const orders = await getTradierGateway("local").getEquityOrders(ACCT);
    expect(orders[0]).toMatchObject({ id: "1", side: "short", type: "stop_market", state: "open", clientOrderId: "abc" });
    expect(orders[1]).toMatchObject({ id: "2", side: "cover", type: "limit", state: "pending" });
  });
});

describe("Tradier adapter — duration mapping", () => {
  async function duration(input: { timeInForce: "gfd" | "gtc"; marketHours: "regular_hours" | "extended_hours"; type?: "market" | "limit" }) {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { id: 9, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "AAPL", side: "buy", type: input.type ?? "market", quantity: 1,
      timeInForce: input.timeInForce, marketHours: input.marketHours,
      ...(input.type === "limit" ? { limitPrice: 100 } : {}),
      refId: "rd"
    });
    return new URLSearchParams(records.find((r) => r.method === "POST")!.body ?? "").get("duration");
  }

  it("gfd->day, gtc->gtc for regular hours", async () => {
    expect(await duration({ timeInForce: "gfd", marketHours: "regular_hours" })).toBe("day");
    expect(await duration({ timeInForce: "gtc", marketHours: "regular_hours" })).toBe("gtc");
  });

  it("extended_hours + limit -> pre or post", async () => {
    const d = await duration({ timeInForce: "gfd", marketHours: "extended_hours", type: "limit" });
    expect(["pre", "post"]).toContain(d);
  });

  it("extended_hours on a NON-limit falls back to the TIF session (Tradier fills extended only as limit)", async () => {
    expect(await duration({ timeInForce: "gfd", marketHours: "extended_hours", type: "market" })).toBe("day");
  });
});

describe("Tradier adapter — whole-share resolution", () => {
  it("floors a dollarAmount order to whole shares using a mocked quote", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u) => u.includes("/markets/quotes"), body: { quotes: { quote: { symbol: "AAPL", last: 100 } } } },
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { id: 3, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "AAPL", side: "buy", type: "market", dollarAmount: 550,
      timeInForce: "gfd", marketHours: "regular_hours", refId: "rq"
    });
    const post = records.find((r) => r.method === "POST")!;
    expect(new URLSearchParams(post.body ?? "").get("quantity")).toBe("5"); // floor(550/100)
  });

  it("THROWS (never quantity 1) when there is no positive price to size a dollar order", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u) => u.includes("/markets/quotes"), body: { quotes: { quote: { symbol: "AAPL" } } } } // no price
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await expect(
      getTradierGateway("local").placeEquityOrder({
        accountNumber: ACCT, symbol: "AAPL", side: "buy", type: "market", dollarAmount: 550,
        timeInForce: "gfd", marketHours: "regular_hours", refId: "rt"
      })
    ).rejects.toThrow(/whole share/i);
  });

  it("getEquityTradability reports fractional:false for all symbols", async () => {
    await seedTradier();
    installFetchMock([]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const t = await getTradierGateway("local").getEquityTradability(ACCT, ["AAPL", "brk-b"]);
    expect(t.AAPL).toEqual({ tradable: true, fractional: false });
    expect(t["BRK-B"]).toEqual({ tradable: true, fractional: false });
  });
});

describe("Tradier adapter — placement response mapping", () => {
  it("maps {order:{id,status:'ok'}} -> {orderId, state:'pending'}", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { id: 777, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const res = await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "AAPL", side: "buy", type: "market", quantity: 1,
      timeInForce: "gfd", marketHours: "regular_hours", refId: "ro"
    });
    expect(res).toMatchObject({ orderId: "777", state: "pending", refId: "ro" });
    expect(res.filledQuantity).toBeUndefined();
  });

  it("a missing order id THROWS", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await expect(
      getTradierGateway("local").placeEquityOrder({
        accountNumber: ACCT, symbol: "AAPL", side: "buy", type: "market", quantity: 1,
        timeInForce: "gfd", marketHours: "regular_hours", refId: "rn"
      })
    ).rejects.toThrow(/no order id/i);
  });

  it("a synchronous 'rejected' status passes through verbatim", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { order: { id: 12, status: "rejected" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const res = await getTradierGateway("local").placeEquityOrder({
      accountNumber: ACCT, symbol: "AAPL", side: "buy", type: "market", quantity: 1,
      timeInForce: "gfd", marketHours: "regular_hours", refId: "rr"
    });
    expect(res.state).toBe("rejected");
    const { isRejectedOrCanceledState } = await import("../src/lib/broker-side");
    expect(isRejectedOrCanceledState(res.state)).toBe(true);
  });

  it("throws a joined message on a Tradier error envelope", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u, m) => m === "POST" && u.includes("/orders"), body: { errors: { error: ["side is required", "quantity is required"] } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await expect(
      getTradierGateway("local").placeEquityOrder({
        accountNumber: ACCT, symbol: "AAPL", side: "buy", type: "market", quantity: 1,
        timeInForce: "gfd", marketHours: "regular_hours", refId: "re"
      })
    ).rejects.toThrow(/side is required; quantity is required/);
  });
});

describe("Tradier adapter — envelope normalization", () => {
  it("normalizes a single-object {orders:{order:{...}}} and empty 'null'", async () => {
    await seedTradier();
    // Single object
    installFetchMock([
      { match: (u) => u.includes("/orders"), body: { orders: { order: { id: 1, symbol: "AAPL", side: "buy", type: "market", status: "filled", create_date: "2026-07-10" } } } }
    ]);
    const mod1 = await import("../src/lib/tradier");
    const one = await mod1.getTradierGateway("local").getEquityOrders(ACCT);
    expect(one).toHaveLength(1);
    expect(one[0].id).toBe("1");

    // Empty "null"
    vi.resetModules();
    await seedTradier();
    installFetchMock([
      { match: (u) => u.includes("/orders"), body: { orders: "null" } }
    ]);
    const mod2 = await import("../src/lib/tradier");
    const none = await mod2.getTradierGateway("local").getEquityOrders(ACCT);
    expect(none).toEqual([]);
  });
});

describe("Tradier adapter — quotes", () => {
  it("batches /markets/quotes and follows last->close->ask->bid precedence", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      {
        match: (u) => u.includes("/markets/quotes"),
        body: { quotes: { quote: [
          { symbol: "AAPL", last: 190, close: 188, ask: 191, bid: 189, volume: 1000, trade_date: 1751000000000 },
          { symbol: "MSFT", close: 400 } // no last -> close
        ] } }
      }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const quotes = await getTradierGateway("local").getEquityQuotes(ACCT, ["AAPL", "MSFT"]);
    expect(quotes.AAPL.price).toBe(190);
    expect(quotes.MSFT.price).toBe(400);
    const call = records.find((r) => r.url.includes("/markets/quotes"))!;
    expect(call.url).toContain("symbols=AAPL%2CMSFT");
    expect(call.authorization).toBe(`Bearer ${SANDBOX_TOKEN}`);
  });

  it("a quote-fetch error warns and does NOT throw (falls through to Yahoo floor -> no data -> price 0)", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u) => u.includes("/markets/quotes"), body: { error: "boom" }, status: 500 }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const quotes = await getTradierGateway("local").getEquityQuotes(ACCT, ["AAPL"]);
    // No throw; symbol may be absent or priced 0 from the (mocked-404) Yahoo floor.
    expect(quotes.AAPL?.price ?? 0).toBe(0);
  });
});

describe("Tradier adapter — getPortfolio", () => {
  it("uses margin.stock_buying_power for a margin account", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u) => u.includes("/balances"), body: { balances: { account_number: ACCT, total_equity: 10000, total_cash: 2000, market_value: 8000, margin: { stock_buying_power: 16000 } } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const p = await getTradierGateway("local").getPortfolio(ACCT);
    expect(p).toMatchObject({ totalMarketValue: 10000, cash: 2000, buyingPower: 16000, equityMarketValue: 8000 });
  });

  it("uses cash.cash_available for a cash account", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u) => u.includes("/balances"), body: { balances: { account_number: ACCT, total_equity: 5000, total_cash: 3000, market_value: 2000, cash: { cash_available: 2500 } } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const p = await getTradierGateway("local").getPortfolio(ACCT);
    expect(p.buyingPower).toBe(2500);
  });

  it("throws Account Mismatch only on a genuinely differing account_number", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u) => u.includes("/balances"), body: { balances: { account_number: "OTHER999", total_equity: 1, total_cash: 1 } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    await expect(getTradierGateway("local").getPortfolio(ACCT)).rejects.toThrow(/Account Mismatch/);
  });
});

describe("Tradier adapter — positions", () => {
  it("divides total cost_basis by quantity for averageCost and prices via a quote", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u) => u.includes("/positions"), body: { positions: { position: { symbol: "AAPL", quantity: 10, cost_basis: 1500 } } } },
      { match: (u) => u.includes("/markets/quotes"), body: { quotes: { quote: { symbol: "AAPL", last: 200 } } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const pos = await getTradierGateway("local").getEquityPositions(ACCT);
    expect(pos[0]).toMatchObject({ symbol: "AAPL", quantity: 10, averageCost: 150, marketValue: 2000 });
  });
});

describe("Tradier adapter — capsFromProfile", () => {
  it("margin -> shortSelling/marginEnabled true; classifications map to account types", async () => {
    await seedTradier();
    installFetchMock([
      { match: (u) => u.includes("/user/profile"), body: { profile: { account: [
        { account_number: "A1", type: "margin", classification: "individual", option_level: 0 },
        { account_number: "A2", type: "cash", classification: "ira_roth" },
        { account_number: "A3", type: "cash", classification: "traditional_ira" }
      ] } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const accts = await getTradierGateway("local").getAccounts();
    expect(accts).toHaveLength(3);
    expect(accts[0].capabilities).toMatchObject({ shortSelling: true, marginEnabled: true, accountType: "brokerage", optionsTrading: false });
    expect(accts[1].capabilities).toMatchObject({ shortSelling: false, accountType: "roth_ira" });
    expect(accts[2].capabilities).toMatchObject({ accountType: "traditional_ira" });
  });
});

describe("Tradier adapter — cancel", () => {
  it("DELETEs the order and returns the broker status", async () => {
    await seedTradier();
    const { records } = installFetchMock([
      { match: (u, m) => m === "DELETE" && u.includes("/orders/42"), body: { order: { id: 42, status: "ok" } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    const res = await getTradierGateway("local").cancelEquityOrder(ACCT, "42");
    expect(res.orderId).toBe("42");
    expect(records.some((r) => r.method === "DELETE" && r.url.includes("/orders/42"))).toBe(true);
  });
});

describe("Tradier adapter — tenant isolation", () => {
  it("user B never resolves user A's stored token; a non-owner with no row throws", async () => {
    await seedTradier({ userId: "local", environment: "paper", token: SANDBOX_TOKEN });
    installFetchMock([
      { match: (u) => u.includes("/user/profile"), body: { profile: { account: { account_number: ACCT, type: "margin", classification: "individual" } } } }
    ]);
    const { getTradierGateway } = await import("../src/lib/tradier");
    // User B has no Tradier row -> construction throws, never borrows 'local'.
    expect(() => getTradierGateway("u_other")).toThrow(/No Tradier account connected/);
  });
});
