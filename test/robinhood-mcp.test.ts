import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-rh-mcp-${randomUUID()}.db`)}`;
});

describe("robinhood mcp transport", () => {
  it("sends streamable HTTP headers and unwraps SSE tool results", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTH_TOKEN", "test-token");
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const result = {
        jsonrpc: "2.0",
        id: "1",
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ data: { accounts: [{ account_number: "A1", nickname: "Agentic" }] }, guide: "ok" })
            }
          ]
        }
      };
      return new Response(`event: message\ndata: ${JSON.stringify(result)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });

    const { callRobinhoodMcpTool, ROBINHOOD_TRADING_MCP_URL } = await import("../src/lib/robinhood");
    // The legacy env override is migrated into local's stored token at boot; exercise that path.
    const { migrateLocalRobinhoodToken } = await import("../src/lib/mcp-oauth");
    migrateLocalRobinhoodToken();

    const raw = await callRobinhoodMcpTool("local", "get_accounts", {});

    expect(raw).toEqual({ accounts: [{ account_number: "A1", nickname: "Agentic" }] });
    expect(calls[0].url).toBe(ROBINHOOD_TRADING_MCP_URL);
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("accept")).toBe("application/json, text/event-stream");
    expect(headers.get("mcp-protocol-version")).toBe("2025-03-26");
    expect(headers.get("authorization")).toBe("Bearer test-token");
  });

  it("parses JSON structuredContent tool results", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTH_TOKEN", "test-token");
    vi.stubEnv("ROBINHOOD_MCP_URL", "https://mcp.example.test/trading");
    vi.stubGlobal("fetch", async () => {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: {
            structuredContent: { data: { quotes: [{ symbol: "AAPL", price: "200" }] }, guide: "ok" }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { callRobinhoodMcpTool } = await import("../src/lib/robinhood");

    await expect(callRobinhoodMcpTool("user-a", "get_equity_quotes", { symbols: ["AAPL"] })).resolves.toEqual({
      quotes: [{ symbol: "AAPL", price: "200" }]
    });
  });

  it("reports missing auth without calling the MCP server", async () => {
    vi.stubEnv("ROBINHOOD_ADAPTER", "mcp");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { getRobinhoodMcpHealth } = await import("../src/lib/robinhood");
    const health = await getRobinhoodMcpHealth("user-a");

    expect(health.ok).toBe(false);
    expect(health.configured).toBe(true);
    expect(health.authenticated).toBe(false);
    expect(health.error).toContain("No Robinhood MCP access token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists available tools through the health check", async () => {
    vi.stubEnv("ROBINHOOD_ADAPTER", "mcp");
    vi.stubEnv("ROBINHOOD_MCP_AUTH_TOKEN", "test-token");
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? "{}"));
      methods.push(request.method);
      if (request.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-03-26" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { tools: [{ name: "place_equity_order" }, { name: "get_accounts" }, { name: "get_equity_quotes" }] }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const { getRobinhoodMcpHealth } = await import("../src/lib/robinhood");
    // The legacy env override is migrated into local's stored token at boot; exercise that path.
    const { migrateLocalRobinhoodToken } = await import("../src/lib/mcp-oauth");
    migrateLocalRobinhoodToken();

    // Health check as the `local` primary user (its token came from the boot migration).
    await expect(getRobinhoodMcpHealth("local")).resolves.toMatchObject({
      ok: true,
      authenticated: true,
      tools: ["get_accounts", "get_equity_quotes", "place_equity_order"]
    });
    expect(methods).toEqual(["initialize", "tools/list"]);
  });

  it("surfaces JSON-RPC errors with the broker message", async () => {
    vi.stubEnv("ROBINHOOD_MCP_AUTH_TOKEN", "test-token");
    vi.stubGlobal("fetch", async () => {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -32000, message: "not authorized" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const { callRobinhoodMcpTool } = await import("../src/lib/robinhood");

    await expect(callRobinhoodMcpTool("user-a", "get_accounts", {})).rejects.toThrow("not authorized");
  });

  it("parses cash-only Robinhood portfolio shapes without zeroing balances", async () => {
    const { portfolioFromRobinhoodRaw } = await import("../src/lib/robinhood");

    const portfolio = portfolioFromRobinhoodRaw("713670347", {
      buying_power: { buying_power: "100.00", display_currency: "USD" },
      cash_balances: { cash_available_for_withdrawal: "$100.00" },
      equity_market_value: "0"
    });

    expect(portfolio).toMatchObject({
      accountNumber: "713670347",
      totalMarketValue: 100,
      buyingPower: 100,
      equityMarketValue: 0,
      cash: 100
    });
  });

  it("infers a cash-only total from buying power when Robinhood omits cash fields", async () => {
    const { portfolioFromRobinhoodRaw } = await import("../src/lib/robinhood");

    const portfolio = portfolioFromRobinhoodRaw("713670347", {
      buyingPower: { amount: "100.00" },
      stock_value: "0.00",
      options_value: "0.00"
    });

    expect(portfolio.totalMarketValue).toBe(100);
    expect(portfolio.cash).toBe(100);
    expect(portfolio.buyingPower).toBe(100);
  });

  it("does not let an explicit zero total override positive cash", async () => {
    const { portfolioFromRobinhoodRaw } = await import("../src/lib/robinhood");

    const portfolio = portfolioFromRobinhoodRaw("713670347", {
      total_value: "0.00",
      buying_power: { amount: "100.00" },
      cash: "100.00"
    });

    expect(portfolio.totalMarketValue).toBe(100);
    expect(portfolio.cash).toBe(100);
  });
});
