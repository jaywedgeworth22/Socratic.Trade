import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-alt-test-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.FRED_API_KEY;
  delete process.env.FINNHUB_API_KEY;
});

describe("Yahoo Finance Quotes", () => {
  it("fetches and parses Yahoo Finance chart data correctly", async () => {
    const { fetchYahooFinanceQuote } = await import("../src/lib/robinhood");

    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("query1.finance.yahoo.com")) {
        return new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: {
                    regularMarketPrice: 205.5,
                    chartPreviousClose: 203.2
                  },
                  indicators: {
                    quote: [
                      {
                        volume: [1500000]
                      }
                    ]
                  }
                }
              ]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });

    const quote = await fetchYahooFinanceQuote("AAPL");
    expect(quote).toBeDefined();
    expect(quote?.price).toBe(205.5);
    expect(quote?.prevClose).toBe(203.2);
    expect(quote?.volume).toBe(1500000);
    expect(quote?.bid).toBeCloseTo(205.5 * 0.999);
    expect(quote?.ask).toBeCloseTo(205.5 * 1.001);
  });

  it("returns undefined on network failure", async () => {
    const { fetchYahooFinanceQuote } = await import("../src/lib/robinhood");

    vi.stubGlobal("fetch", async () => {
      return new Response("error", { status: 500 });
    });

    const quote = await fetchYahooFinanceQuote("INVALID");
    expect(quote).toBeUndefined();
  });
});

describe("FRED Macroeconomic Data", () => {
  it("returns defaults when FRED_API_KEY is not set", async () => {
    const { fetchMacroData } = await import("../src/lib/macro");
    delete process.env.FRED_API_KEY;

    const data = await fetchMacroData();
    expect(data.fedFundsRate).toBe("5.25%");
    expect(data.dgs10Treasury).toBe("4.20%");
    expect(data.cpiInflation).toBe("3.10%");
    expect(data.unemploymentRate).toBe("3.90%");
  });

  it("fetches from FRED API when API key is set", async () => {
    process.env.FRED_API_KEY = "test-key";
    const { fetchMacroData } = await import("../src/lib/macro");

    vi.stubGlobal("fetch", async (url: string) => {
      let value = "0.0";
      if (url.includes("FEDFUNDS")) value = "5.33";
      else if (url.includes("DGS10")) value = "4.45";
      else if (url.includes("CPIAUCSL")) value = "3.25";
      else if (url.includes("UNRATE")) value = "4.0";

      return new Response(
        JSON.stringify({
          observations: [{ value }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const data = await fetchMacroData();
    expect(data.fedFundsRate).toBe("5.33%");
    expect(data.dgs10Treasury).toBe("4.45%");
    expect(data.cpiInflation).toBe("3.25%");
    expect(data.unemploymentRate).toBe("4.00%");
  });
});

describe("Finnhub News Enrichment", () => {
  it("uses Yahoo Finance provider when no API key is configured", async () => {
    delete process.env.FINNHUB_API_KEY;
    delete process.env.FMP_API_KEY;
    const { getEnrichmentProvider } = await import("../src/lib/data-providers");

    const provider = getEnrichmentProvider();
    // Yahoo Finance is the final real tier — always configured, no API key required.
    expect(provider.configured).toBe(true);
    expect(provider.name).toBe("yahoo-finance");
  });

  it("fetches and scores company news from Finnhub when key is configured", async () => {
    process.env.FINNHUB_API_KEY = "finnhub-key";
    delete process.env.FMP_API_KEY;
    const { getEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("company-news")) {
        return new Response(
          JSON.stringify([
            { headline: "AAPL surges as new AI chip outperforms competitors" },
            { headline: "Apple wins major patent lawsuit against rival" }
          ]),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      // Other Finnhub endpoints return empty but valid responses.
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    });

    const provider = getEnrichmentProvider();
    expect(provider.configured).toBe(true);
    // With Finnhub key the cascade is finnhub+yahoo-finance.
    expect(provider.name).toContain("finnhub");

    const result = await provider.enrich(["AAPL"]);
    expect(result.AAPL).toBeDefined();
    expect(result.AAPL.sentiment).toBeGreaterThan(50); // surges, outperforms, wins → positive
    expect(result.AAPL.headlines).toHaveLength(2);
    expect(result.AAPL.headlines?.[0]).toContain("AAPL surges");
  });
});

describe("Discord Rich Notification Webhook", () => {
  it("formats Discord payload with embeds and color codes", async () => {
    const { sendNotification } = await import("../src/lib/notifications");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");

    let capturedBody: any = null;
    const mockFetcher = async (url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(null, { status: 204 });
    };

    const policy = {
      ...DEFAULT_POLICY,
      notificationSettings: {
        enabledEvents: ["fill", "block", "pending_approval", "kill_switch", "run_failed"] as any[],
        webhookUrl: "https://discord.com/api/webhooks/12345/abcde"
      }
    };

    // Test Pending Approval (Orange color: 15105570)
    await sendNotification(
      {
        type: "pending_approval",
        title: "AAPL awaiting approval",
        payload: {
          proposalId: "p-1",
          proposal: {
            symbol: "AAPL",
            side: "buy",
            type: "market",
            dollarAmount: 50,
            rationale: "Strong earnings report"
          },
          review: { estimatedNotional: 49.95 }
        }
      },
      { policy, fetcher: mockFetcher }
    );

    expect(capturedBody).toBeDefined();
    expect(capturedBody.embeds).toHaveLength(1);
    const embed = capturedBody.embeds[0];
    expect(embed.title).toBe("AAPL awaiting approval");
    expect(embed.color).toBe(15105570); // Orange
    expect(embed.description).toBe("**Rationale:** Strong earnings report");
    expect(embed.fields).toContainEqual({ name: "Symbol", value: "AAPL", inline: true });
    expect(embed.fields).toContainEqual({ name: "Side", value: "BUY", inline: true });
    expect(embed.fields).toContainEqual({ name: "Dollar Amount", value: "$50.00", inline: true });

    // Test Fill Notification (Green color: 3066993)
    await sendNotification(
      {
        type: "fill",
        title: "AAPL Paper fill",
        payload: {
          runId: "run-123",
          fill: {
            symbol: "AAPL",
            side: "buy",
            status: "filled",
            quantity: 2,
            price: 200,
            notional: 400
          }
        }
      },
      { policy, fetcher: mockFetcher }
    );

    expect(capturedBody.embeds[0].color).toBe(3066993);
    expect(capturedBody.embeds[0].fields).toContainEqual({ name: "Symbol", value: "AAPL", inline: true });
    expect(capturedBody.embeds[0].fields).toContainEqual({ name: "Price", value: "$200.00", inline: true });
    expect(capturedBody.embeds[0].fields).toContainEqual({ name: "Notional", value: "$400.00", inline: true });
  });
});
