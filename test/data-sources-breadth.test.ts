import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Isolated SQLite db so db-health / consent state doesn't leak across files.
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-breadth-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.ROBINHOOD_OPTIONS_ENRICHMENT_ENABLED;
  delete process.env.ROBINHOOD_ADAPTER;
  delete process.env.ENRICHMENT_CIRCUIT_BREAKER_ENABLED;
  delete process.env.FMP_API_KEY;
});

// ── Item 1: daysToEarnings (Yahoo calendarEvents) ────────────────────────────
describe("daysToEarnings (Yahoo calendarEvents)", () => {
  it("returns whole days to the earliest FUTURE earnings date", async () => {
    const { parseDaysToEarnings } = await import("../src/lib/data-providers");
    const now = Date.UTC(2026, 6, 1); // 2026-07-01
    const inTenDays = Math.floor(Date.UTC(2026, 6, 11) / 1000);
    const ce = { earnings: { earningsDate: [{ raw: inTenDays }] } };
    expect(parseDaysToEarnings(ce, now)).toBe(10);
  });

  it("ignores a past earnings date and returns undefined (never 0/guess)", async () => {
    const { parseDaysToEarnings } = await import("../src/lib/data-providers");
    const now = Date.UTC(2026, 6, 1);
    const tenDaysAgo = Math.floor(Date.UTC(2026, 5, 21) / 1000);
    const ce = { earnings: { earningsDate: [{ raw: tenDaysAgo }] } };
    expect(parseDaysToEarnings(ce, now)).toBeUndefined();
  });

  it("returns undefined when calendarEvents has no earnings date", async () => {
    const { parseDaysToEarnings } = await import("../src/lib/data-providers");
    expect(parseDaysToEarnings({}, Date.now())).toBeUndefined();
    expect(parseDaysToEarnings({ earnings: {} }, Date.now())).toBeUndefined();
  });

  it("picks the earliest of a lo/hi window", async () => {
    const { parseDaysToEarnings } = await import("../src/lib/data-providers");
    const now = Date.UTC(2026, 6, 1);
    const d1 = Math.floor(Date.UTC(2026, 6, 20) / 1000);
    const d2 = Math.floor(Date.UTC(2026, 6, 24) / 1000);
    const ce = { earnings: { earningsDate: [{ raw: d2 }, { raw: d1 }] } };
    expect(parseDaysToEarnings(ce, now)).toBe(19);
  });
});

// ── Item 3: institutional ownership ──────────────────────────────────────────
describe("institution ownership (Yahoo majorHoldersBreakdown / institutionOwnership)", () => {
  it("reads majorHoldersBreakdown.institutionsPercentHeld as a 0-100 pct", async () => {
    const { parseInstitutionOwnershipPct } = await import("../src/lib/data-providers");
    expect(parseInstitutionOwnershipPct({ institutionsPercentHeld: { raw: 0.6234 } }, {})).toBe(62.34);
  });

  it("falls back to summing the institutionOwnership list", async () => {
    const { parseInstitutionOwnershipPct } = await import("../src/lib/data-providers");
    const io = { ownershipList: [{ pctHeld: { raw: 0.1 } }, { pctHeld: { raw: 0.05 } }] };
    expect(parseInstitutionOwnershipPct({}, io)).toBe(15);
  });

  it("returns undefined when neither source is present", async () => {
    const { parseInstitutionOwnershipPct } = await import("../src/lib/data-providers");
    expect(parseInstitutionOwnershipPct({}, {})).toBeUndefined();
  });
});

// ── Items 1 & 3 threaded through the Yahoo provider via a real fetch stub ─────
describe("Yahoo enrichment threads earnings + institution ownership through the cascade", () => {
  it("surfaces daysToEarnings and institutionOwnershipPct on the merged enrichment", async () => {
    const { getEnrichmentProvider, clearEnrichmentCache } = await import("../src/lib/data-providers");
    clearEnrichmentCache();

    const inTwelveDays = Math.floor((Date.now() + 12 * 86_400_000) / 1000);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://fc.yahoo.com") return new Response("", { status: 200, headers: { "set-cookie": "B=t" } });
      if (url.includes("/v1/test/getcrumb")) return new Response("crumb", { status: 200, headers: { "content-type": "text/plain" } });
      if (url.includes("/v10/finance/quoteSummary/AAPL")) {
        return new Response(
          JSON.stringify({
            quoteSummary: {
              result: [
                {
                  summaryDetail: {},
                  defaultKeyStatistics: {},
                  financialData: {},
                  assetProfile: { sector: "Technology", industry: "Consumer Electronics" },
                  calendarEvents: { earnings: { earningsDate: [{ raw: inTwelveDays }] } },
                  majorHoldersBreakdown: { institutionsPercentHeld: { raw: 0.61 } }
                }
              ]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });

    const provider = getEnrichmentProvider(); // yahoo-only cascade (no keys set)
    const out = await provider.enrich(["AAPL"]);
    expect(out.AAPL.daysToEarnings).toBe(12);
    expect(out.AAPL.institutionOwnershipPct).toBe(61);
    expect(out.AAPL.sources?.daysToEarnings).toBe("yahoo-finance");
    expect(out.AAPL.sources?.institutionOwnershipPct).toBe("yahoo-finance");
  });
});

// ── Item 4: Robinhood option-chain tier ──────────────────────────────────────
describe("Robinhood options enrichment tier (opt-in)", () => {
  it("stays out of the cascade by default (flag off)", async () => {
    const provider = (await import("../src/lib/data-providers")).getEnrichmentProvider();
    expect(provider.name).not.toContain("robinhood-options");
  });

  it("joins the cascade only when the flag AND Robinhood MCP are both on", async () => {
    process.env.ROBINHOOD_OPTIONS_ENRICHMENT_ENABLED = "on";
    process.env.ROBINHOOD_ADAPTER = "mcp";
    const provider = (await import("../src/lib/data-providers")).getEnrichmentProvider("user-1");
    expect(provider.name).toContain("robinhood-options");
  });

  it("derives near-the-money IV and put/call ratio from raw chain payloads", async () => {
    const { deriveOptionMetrics } = await import("../src/lib/robinhood-options");
    const chains = {
      results: [
        { strike_price: 95, type: "call", implied_volatility: 0.30, open_interest: 100 },
        { strike_price: 100, type: "call", implied_volatility: 0.32, open_interest: 200 },
        { strike_price: 100, type: "put", implied_volatility: 0.35, open_interest: 300 },
        { strike_price: 200, type: "call", implied_volatility: 0.9, open_interest: 10 } // far OTM, excluded from p/c
      ]
    };
    const metrics = deriveOptionMetrics({ chains, instruments: undefined }, 100);
    // Closest strike to 100 with an IV → the 100-strike (0.32 → 32%).
    expect(metrics.nearTheMoneyIv).toBe(32);
    // Around-the-money OI: puts 300 / calls (100+200)=300 → 1.0; far OTM 200-strike excluded.
    expect(metrics.putCallRatio).toBe(1);
  });

  it("returns an empty object (no fabrication) when the chain has no usable rows", async () => {
    const { deriveOptionMetrics } = await import("../src/lib/robinhood-options");
    expect(deriveOptionMetrics({ chains: { results: [] }, instruments: undefined }, 100)).toEqual({});
  });

  it("provider fails closed (empty) with no userId in scope", async () => {
    const { RobinhoodOptionsEnrichmentProvider } = await import("../src/lib/robinhood-options");
    const out = await new RobinhoodOptionsEnrichmentProvider(undefined).enrich(["AAPL"]);
    expect(out.AAPL).toEqual({});
  });
});

// ── Item 5: active circuit breaker ───────────────────────────────────────────
describe("enrichment circuit breaker (opt-in)", () => {
  it("skips a lane whose db-health is stoppedWorking, but retries after backoff", async () => {
    const mod = await import("../src/lib/data-providers");
    const { applyCircuitBreaker } = mod;
    const { logApiHealth } = await import("../src/lib/db-health");
    const { getDb } = await import("../src/lib/db");
    getDb().prepare("DELETE FROM api_health_log WHERE service = ?").run("finnhub");

    // 5 consecutive failures → stoppedWorking for the finnhub lane.
    for (let i = 0; i < 5; i++) logApiHealth({ service: "finnhub", ok: false, errorText: "HTTP 500" });

    const finnhubLike: import("../src/lib/data-providers").MarketEnrichmentProvider = {
      name: "finnhub",
      configured: true,
      async enrich(symbols) {
        const out: Record<string, import("../src/lib/data-providers").SymbolEnrichment> = {};
        for (const s of symbols) out[s] = { peRatio: 10 };
        return out;
      }
    };
    const yahooLike: import("../src/lib/data-providers").MarketEnrichmentProvider = {
      name: "yahoo-finance",
      configured: true,
      async enrich() {
        return {};
      }
    };

    // Long backoff → the tripped lane is skipped this scan (last failure is fresh).
    process.env.ENRICHMENT_CIRCUIT_BREAKER_BACKOFF_MIN = "60";
    const tripped = applyCircuitBreaker([finnhubLike, yahooLike]);
    const finnhubOut = await tripped[0].enrich(["AAPL"]);
    expect(finnhubOut.AAPL).toEqual({}); // no-op'd — did NOT return peRatio
    expect(tripped[0].name).toBe("finnhub"); // lane name preserved

    // Age every finnhub failure row well past the backoff window → the lane may re-probe.
    const oldTs = new Date(Date.now() - 90 * 60_000).toISOString();
    getDb().prepare("UPDATE api_health_log SET ts = ? WHERE service = ?").run(oldTs, "finnhub");
    const reprobe = applyCircuitBreaker([finnhubLike, yahooLike]);
    const reprobeOut = await reprobe[0].enrich(["AAPL"]);
    expect(reprobeOut.AAPL).toEqual({ peRatio: 10 });
    delete process.env.ENRICHMENT_CIRCUIT_BREAKER_BACKOFF_MIN;
  });

  it("leaves a healthy lane untouched", async () => {
    const { applyCircuitBreaker } = await import("../src/lib/data-providers");
    const { logApiHealth } = await import("../src/lib/db-health");
    const { getDb } = await import("../src/lib/db");
    getDb().prepare("DELETE FROM api_health_log WHERE service = ?").run("fmp");
    logApiHealth({ service: "fmp", ok: true, latencyMs: 20 });

    const fmpLike: import("../src/lib/data-providers").MarketEnrichmentProvider = {
      name: "fmp",
      configured: true,
      async enrich(symbols) {
        const out: Record<string, import("../src/lib/data-providers").SymbolEnrichment> = {};
        for (const s of symbols) out[s] = { peRatio: 22 };
        return out;
      }
    };
    const [wrapped] = applyCircuitBreaker([fmpLike]);
    expect(await wrapped.enrich(["AAPL"])).toEqual({ AAPL: { peRatio: 22 } });
  });
});
