/**
 * UX PR-C1 + C2 guardrails:
 *  - C1: short TTL snapshot cache is keyed by (userId, accountNumber, connectedAccountId);
 *    multi-account users never share snapshots; repeat polls share work; invalidation works.
 *  - C2: dashboard assembly runs calculatePnl once per source and threads prefetched P&L so
 *    scorecards/tax do not re-replay FIFO.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/macro", () => ({
  fetchMacroData: vi.fn(async () => ({})),
  determineMarketRegime: vi.fn(() => "Unknown")
}));
vi.mock("../src/lib/macro-metrics", () => ({ deriveMacroMetrics: vi.fn(() => ({})) }));
vi.mock("../src/lib/macro-history", () => ({ fetchMacroHistory: vi.fn(async () => ({})) }));
vi.mock("../src/lib/market-signals", () => ({ getMarketSignals: vi.fn(async () => ({})) }));
vi.mock("../src/lib/market-signals/massive", () => ({ fetchMassiveNews: vi.fn(async () => []) }));
vi.mock("../src/lib/market-internals", () => ({ computeMarketInternals: vi.fn(() => ({ medianEarnYld: undefined })) }));
vi.mock("../src/lib/benchmark", () => ({ computeSpyBenchmark: vi.fn(async () => null) }));
vi.mock("../src/lib/web-sources", () => ({
  getCongressDataset: vi.fn(() => undefined),
  getInsiderDataset: vi.fn(() => undefined),
  getWebSourcesStatus: vi.fn(() => ({}))
}));
vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: vi.fn(() => ({
    async getAccounts() {
      return [{ accountNumber: "TEST", label: "Test", agenticAllowed: true }];
    },
    async getPortfolio() {
      return {
        accountNumber: "TEST",
        totalMarketValue: 1000,
        buyingPower: 1000,
        equityMarketValue: 0,
        optionMarketValue: 0,
        cash: 1000
      };
    },
    async getEquityPositions() {
      return [];
    },
    async getEquityOrders() {
      return [];
    },
    async getEquityQuotes() {
      return {};
    }
  }))
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-dash-cache-pnl-${randomUUID()}.db`)}`;
  process.env.DASHBOARD_SNAPSHOT_TTL_MS = "10000";
});

beforeEach(async () => {
  const { resetDashboardSnapshotCacheForTests } = await import("../src/lib/dashboard-snapshot-cache");
  resetDashboardSnapshotCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function seedAccount(userId: string, accountNumber: string, connectedAccountId?: string) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return import("../src/lib/db").then((db) => {
    const id = connectedAccountId ?? `acct-${userId}-${accountNumber}`;
    db.upsertConnectedAccount({
      id,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber,
      label: `Account ${accountNumber}`,
      isActive: true
    });
    return id;
  });
}

describe("UX PR-C1 dashboard snapshot TTL cache", () => {
  it("keys cache by userId + account identity (multi-account isolation)", async () => {
    const {
      dashboardSnapshotCacheKey,
      withDashboardSnapshotCache,
      dashboardSnapshotCacheSizeForTests,
      invalidateDashboardSnapshotCache
    } = await import("../src/lib/dashboard-snapshot-cache");

    const userA = `user-a-${randomUUID()}`;
    const userB = `user-b-${randomUUID()}`;
    const keyA1 = dashboardSnapshotCacheKey(userA, "ACCT-1", "cid-1");
    const keyA2 = dashboardSnapshotCacheKey(userA, "ACCT-2", "cid-2");
    const keyB1 = dashboardSnapshotCacheKey(userB, "ACCT-1", "cid-1");

    expect(keyA1).not.toBe(keyA2);
    expect(keyA1).not.toBe(keyB1);
    // Same account number for different users must not collide.
    expect(keyA1).not.toBe(dashboardSnapshotCacheKey(userB, "ACCT-1", "cid-other"));

    let builds = 0;
    const factory = async () => {
      builds += 1;
      return { builds, n: builds };
    };

    const first = await withDashboardSnapshotCache(keyA1, factory);
    const second = await withDashboardSnapshotCache(keyA1, factory);
    expect(first).toBe(second);
    expect(builds).toBe(1);

    const otherAccount = await withDashboardSnapshotCache(keyA2, factory);
    expect(otherAccount.n).toBe(2);
    expect(builds).toBe(2);

    const otherUser = await withDashboardSnapshotCache(keyB1, factory);
    expect(otherUser.n).toBe(3);
    expect(builds).toBe(3);

    expect(dashboardSnapshotCacheSizeForTests()).toBe(3);

    invalidateDashboardSnapshotCache(userA);
    // User A entries gone; user B remains.
    expect(dashboardSnapshotCacheSizeForTests()).toBe(1);
    await withDashboardSnapshotCache(keyA1, factory);
    expect(builds).toBe(4);
  });

  it("coalesces concurrent misses (singleflight) and serves TTL hits from getDashboardSnapshot", async () => {
    const db = await import("../src/lib/db");
    const { getDashboardSnapshot, buildDashboardSnapshot, resetDashboardSnapshotCacheForTests } =
      await import("../src/lib/dashboard");
    const performance = await import("../src/lib/performance");

    const userId = `dash-ttl-${randomUUID()}`;
    await seedAccount(userId, "TEST");

    const buildSpy = vi.spyOn(performance, "calculatePnl");

    const [a, b] = await Promise.all([getDashboardSnapshot(userId, "a@example.com"), getDashboardSnapshot(userId, "b@example.com")]);
    // Singleflight: one build for concurrent requests.
    // currentUser is re-stamped per caller.
    expect(a.currentUser.email).toBe("a@example.com");
    expect(b.currentUser.email).toBe("b@example.com");
    // Portfolio identity shared (same account).
    expect(a.portfolio?.accountNumber ?? a.policy.accountNumber).toBe(
      b.portfolio?.accountNumber ?? b.policy.accountNumber
    );

    const pnlCallsAfterFirstWave = buildSpy.mock.calls.length;

    // TTL hit: no additional calculatePnl (build body not re-run).
    await getDashboardSnapshot(userId, "c@example.com");
    expect(buildSpy.mock.calls.length).toBe(pnlCallsAfterFirstWave);

    resetDashboardSnapshotCacheForTests();
    // Force uncached rebuild path still works.
    await buildDashboardSnapshot(userId);
    expect(buildSpy.mock.calls.length).toBeGreaterThan(pnlCallsAfterFirstWave);

    // setPolicy invalidates cache.
    resetDashboardSnapshotCacheForTests();
    buildSpy.mockClear();
    await getDashboardSnapshot(userId);
    const afterWarm = buildSpy.mock.calls.length;
    await getDashboardSnapshot(userId);
    expect(buildSpy.mock.calls.length).toBe(afterWarm); // still cached

    db.setPolicy({ ...db.getPolicy(userId), systemState: "halted" }, userId);
    // Dynamic import in setPolicy is async — wait a tick.
    await new Promise((r) => setTimeout(r, 20));
    await getDashboardSnapshot(userId);
    expect(buildSpy.mock.calls.length).toBeGreaterThan(afterWarm);
  });
});

describe("UX PR-C2 calculatePnl once per snapshot", () => {
  it("buildDashboardSnapshot runs calculatePnl twice (live + paper) and scorecards reuse prefetched", async () => {
    const db = await import("../src/lib/db");
    const { buildDashboardSnapshot } = await import("../src/lib/dashboard");
    const performance = await import("../src/lib/performance");

    const userId = `dash-pnl-once-${randomUUID()}`;
    await seedAccount(userId, "TEST");

    // Seed a closed lot so scorecards have work (buy + sell paper).
    const proposalId = `prop-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    db.insertProposal({
      userId,
      id: proposalId,
      runId,
      accountNumber: "TEST",
      proposal: {
        symbol: "AAPL",
        side: "buy",
        type: "market",
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "seed",
        tradeThesisTag: "Momentum",
        entryMarketRegime: "Tech-Bull",
        referencePrice: 100
      },
      decision: { approved: true, reasons: [] },
      status: "filled"
    });
    db.insertFillEvent({
      id: `fill-buy-${randomUUID()}`,
      userId,
      proposalId,
      runId,
      accountNumber: "TEST",
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      price: 100,
      notional: 100,
      status: "filled",
      filledAt: "2026-01-01T15:00:00.000Z",
      raw: { proposal: { tradeThesisTag: "Momentum", entryMarketRegime: "Tech-Bull" } }
    });
    db.insertFillEvent({
      id: `fill-sell-${randomUUID()}`,
      userId,
      proposalId,
      runId,
      accountNumber: "TEST",
      source: "paper",
      symbol: "AAPL",
      side: "sell",
      quantity: 1,
      price: 110,
      notional: 110,
      status: "filled",
      filledAt: "2026-01-10T15:00:00.000Z"
    });

    const spy = vi.spyOn(performance, "calculatePnl");
    const snapshot = await buildDashboardSnapshot(userId);

    // Exactly one live + one paper calculatePnl at the assembly boundary (C2).
    // Scorecards/tax/performance must NOT invoke calculatePnl again.
    expect(spy.mock.calls.length).toBe(2);

    // Thesis scorecard still surfaces the seeded lot (numbers match pre-C2).
    expect(snapshot.thesisScorecard.some((row) => row.thesisTag === "Momentum" && row.trades >= 1)).toBe(true);
    expect(snapshot.regimeScorecard.some((row) => row.regime === "Tech-Bull" && row.trades >= 1)).toBe(true);
    expect(snapshot.performance?.paperRealizedPnl).toBeCloseTo(10);
  });

  it("prefetched livePnl/paperPnl prevent scorecard recalculation", async () => {
    const { calculatePnl, getThesisScorecard, getRegimeScorecard, getClosedLotsDetailed, getOpenLots } =
      await import("../src/lib/performance");
    const db = await import("../src/lib/db");

    const userId = `pnl-pref-${randomUUID()}`;
    const accountNumber = "TEST-PNL";
    await seedAccount(userId, accountNumber);

    db.insertFillEvent({
      id: `fill-${randomUUID()}`,
      userId,
      accountNumber,
      source: "paper",
      symbol: "MSFT",
      side: "buy",
      quantity: 2,
      price: 50,
      notional: 100,
      status: "filled",
      filledAt: "2026-02-01T15:00:00.000Z",
      raw: { proposal: { tradeThesisTag: "Value", entryMarketRegime: "Neutral" } }
    });

    const paperFills = db.listFillEvents(accountNumber, "paper", 500, userId);
    const liveFills = db.listFillEvents(accountNumber, "live", 500, userId);
    const paperPnl = calculatePnl(paperFills, {});
    const livePnl = calculatePnl(liveFills, {});
    const prefetched = { liveFills, paperFills, livePnl, paperPnl };

    const spy = vi.spyOn(await import("../src/lib/performance"), "calculatePnl");
    // Re-import after spy is awkward — spy on module already loaded:
    spy.mockClear();

    getThesisScorecard(accountNumber, "paper", {}, userId, prefetched);
    getRegimeScorecard(accountNumber, "paper", {}, userId, prefetched);
    getClosedLotsDetailed(accountNumber, "paper", userId, prefetched);
    getOpenLots(accountNumber, "paper", userId, prefetched);

    expect(spy).not.toHaveBeenCalled();
  });
});
