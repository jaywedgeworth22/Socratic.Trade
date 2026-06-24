import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMemberScores,
  getCongressAnalyticsOverlay,
  refreshCongressAnalytics
} from "../src/lib/web-sources/congress-analytics";
import { congressAnalyticsScore, outlierInterestScore } from "../src/lib/market";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-congress-analytics-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  delete process.env.CONGRESS_ANALYTICS_ENABLED;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubAnalyticsFetch(p: { tickers?: unknown[]; clusters?: unknown[]; members?: unknown[] }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("ticker-leaderboard")) return new Response(JSON.stringify({ tickers: p.tickers ?? [] }), { status: 200 });
      if (u.includes("cluster-buys")) return new Response(JSON.stringify({ clusters: p.clusters ?? [] }), { status: 200 });
      if (u.includes("member-leaderboard")) return new Response(JSON.stringify({ members: p.members ?? [] }), { status: 200 });
      return new Response("{}", { status: 200 });
    })
  );
}

describe("congress analytics overlay", () => {
  it("is inert when disabled (no fetch, skipped refresh)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await refreshCongressAnalytics(Date.now());
    expect(res.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getCongressAnalyticsOverlay(["ZZZZ"])).toEqual({});
  });

  it("refreshes from App A and builds a per-symbol overlay (incl. cluster + member quality)", async () => {
    process.env.CONGRESS_ANALYTICS_ENABLED = "on";
    stubAnalyticsFetch({
      tickers: [
        { ticker: "aapl", tradeCount: 5, buyCount: 4, sellCount: 1, memberCount: 3, estNetFlowUsd: 250000, estVolumeUsd: 400000, netSentiment: 0.6 }
      ],
      clusters: [{ ticker: "AAPL", memberCount: 3, topMembers: [{ memberName: "Jane Doe" }] }],
      members: [
        { memberName: "Jane Doe", returnPct: 30 },
        { memberName: "John Roe", returnPct: 10 }
      ]
    });
    const res = await refreshCongressAnalytics(Date.now(), true);
    expect(res.ok).toBe(true);
    const overlay = getCongressAnalyticsOverlay(["AAPL"]);
    expect(overlay.AAPL).toMatchObject({ netFlowUsd: 250000, memberCount: 3, cluster: true, clusterMemberCount: 3 });
    expect(overlay.AAPL.topMemberScore).toBe(100); // Jane Doe is the top-ranked member
  });

  it("keeps the prior dataset on an empty pull (App A cold)", async () => {
    process.env.CONGRESS_ANALYTICS_ENABLED = "on";
    stubAnalyticsFetch({ tickers: [], clusters: [], members: [] });
    const res = await refreshCongressAnalytics(Date.now(), true);
    expect(res.ok).toBe(false);
    expect(res.warning).toContain("no analytics");
  });
});

describe("buildMemberScores", () => {
  it("rank-normalizes a performance field to 0–100", () => {
    const m = buildMemberScores([
      { memberName: "A", returnPct: 50 },
      { memberName: "B", returnPct: 10 },
      { memberName: "C", returnPct: 30 }
    ]);
    expect(m.get("a")).toBe(100);
    expect(m.get("b")).toBe(0);
    expect(m.get("c")).toBe(50);
  });

  it("is empty when no performance field is present (inert until App A exposes one)", () => {
    expect(buildMemberScores([{ memberName: "A", trades: 5 }]).size).toBe(0);
  });
});

describe("congressAnalyticsScore + outlierInterestScore boost", () => {
  it("scores net-buying analytics above 0 and net-selling / neutral at 0", () => {
    expect(congressAnalyticsScore({ netFlowUsd: 1_000_000, cluster: true, memberCount: 4, topMemberScore: 80 })).toBeGreaterThan(50);
    expect(congressAnalyticsScore({ netFlowUsd: -1000, netSentiment: -1 })).toBe(0);
    expect(congressAnalyticsScore(undefined)).toBe(0);
  });

  it("lifts outlierInterestScore via the analytics overlay alone (no scraped signal needed)", () => {
    const score = outlierInterestScore({
      bulletins: [],
      congressAnalytics: { netFlowUsd: 5_000_000, cluster: true, memberCount: 5, topMemberScore: 90 }
    });
    expect(score).toBeGreaterThan(60);
  });
});
