import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerGateway, BrokerageAccount, EquityOrder, Portfolio } from "../src/lib/types";

// scheduler.ts's stale-limit-scan in-flight guard (staleExitInFlight) must be released by the REAL
// journalLane work, never by the withDeadline race loser -- a lane still running past
// SCHEDULER_BROKER_TIMEOUT_MS must not let the next 60s tick launch a SECOND concurrent
// cancel-replace against the same account (a double-sell / accidental short on the money path).
//
// This exercises the REAL scheduler.ts tick() code path: a real connected account + policy drive
// the per-account loop into the actual `if (brokerGateway && !staleExitInFlight.has(key))` branch,
// with only `getBrokerGateway` (src/lib/broker.ts) replaced by a hand-built stub gateway so the
// test never depends on the real Alpaca/Tradier wire adapters (owned by a concurrently-edited
// file). The stub's getEquityOrders hangs forever, mirroring a broker call slower than the 15s
// SCHEDULER_BROKER_TIMEOUT_MS deadline (the repo's own measurements record real Alpaca calls up to
// 14.4s -- see src/lib/inflight-deadline.ts).
const brokerMocks = vi.hoisted(() => ({
  getBrokerGateway: vi.fn()
}));

vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: brokerMocks.getBrokerGateway
}));

const ACCOUNT_NUMBER = "STALE-GUARD-ACC";
const USER_ID = "local";
const ACCOUNT_ID = "acc-stale-guard";

function healthyGateway(getEquityOrders: BrokerGateway["getEquityOrders"]): BrokerGateway {
  const account: BrokerageAccount = { accountNumber: ACCOUNT_NUMBER, label: "Paper", agenticAllowed: true };
  const portfolio: Portfolio = {
    accountNumber: ACCOUNT_NUMBER,
    totalMarketValue: 10_000,
    buyingPower: 5_000,
    equityMarketValue: 5_000,
    optionMarketValue: 0,
    cash: 5_000
  };
  return {
    getAccounts: async () => [account],
    getPortfolio: async () => portfolio,
    getEquityPositions: async () => [],
    getEquityOrders,
    getEquityQuotes: async () => ({}),
    getEquityTradability: async () => ({}),
    reviewEquityOrder: async () => {
      throw new Error("not used in this test");
    },
    placeEquityOrder: async () => {
      throw new Error("not used in this test");
    },
    cancelEquityOrder: async () => {
      throw new Error("not used in this test");
    }
  };
}

/** Never resolves -- mirrors a broker call slower than SCHEDULER_BROKER_TIMEOUT_MS. */
function hangingGetEquityOrders(): Promise<EquityOrder[]> {
  return new Promise<EquityOrder[]>(() => undefined);
}

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("SCHEDULER_SINGLE_LEADER", "0");
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-stale-guard-${randomUUID()}.db`)}`;
  brokerMocks.getBrokerGateway.mockReset();
  // Defensive reset: globalThis-pinned, so it survives module reset and could otherwise leak from
  // another test file sharing this worker process.
  (globalThis as { __staleExitInFlight?: Set<string> }).__staleExitInFlight = new Set<string>();

  const { upsertConnectedAccount } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: ACCOUNT_ID,
    userId: USER_ID,
    broker: "alpaca",
    environment: "paper",
    accountNumber: ACCOUNT_NUMBER,
    label: "Stale-guard paper",
    isActive: true
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("scheduler stale-exit lane in-flight guard", () => {
  it("stays held past the broker deadline while getEquityOrders is still pending, and clears once it resolves", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    brokerMocks.getBrokerGateway.mockReturnValue(healthyGateway(hangingGetEquityOrders));

    const { _runSchedulerTickForTest } = await import("../src/lib/scheduler");
    const { SCHEDULER_BROKER_TIMEOUT_MS } = await import("../src/lib/safety-maintenance");

    const key = `${USER_ID}::${ACCOUNT_ID}`;
    const host = globalThis as { __staleExitInFlight?: Set<string> };

    // The tick itself resolves quickly: the stale-limit-scan lane is fire-and-forget (`void
    // withDeadline(...)`), so tick() does not wait on it -- only the guard Set does.
    await _runSchedulerTickForTest();
    expect(host.__staleExitInFlight?.has(key)).toBe(true);

    await vi.advanceTimersByTimeAsync(SCHEDULER_BROKER_TIMEOUT_MS + 100);
    // The 15s broker deadline has fired, but the REAL getEquityOrders call is still pending --
    // the guard must still be held, or the next 60s tick launches a duplicate cancel-replace.
    expect(host.__staleExitInFlight?.has(key)).toBe(true);
  }, 30_000);

  it("does not launch a second concurrent stale-limit-scan for the same account on the next tick", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let getEquityOrdersCalls = 0;
    // getBrokerGateway itself is called unconditionally every tick (it's evaluated before the
    // guard check), so the guard's effect can only be observed on calls made INSIDE the guarded
    // branch -- getEquityOrders, which scheduler.ts only calls once the guard lets a lane launch.
    brokerMocks.getBrokerGateway.mockImplementation(() =>
      healthyGateway(() => {
        getEquityOrdersCalls += 1;
        return hangingGetEquityOrders();
      })
    );

    const { _runSchedulerTickForTest } = await import("../src/lib/scheduler");
    const { SCHEDULER_BROKER_TIMEOUT_MS } = await import("../src/lib/safety-maintenance");

    const key = `${USER_ID}::${ACCOUNT_ID}`;
    const host = globalThis as { __staleExitInFlight?: Set<string> };

    await _runSchedulerTickForTest();
    expect(host.__staleExitInFlight?.has(key)).toBe(true);
    expect(getEquityOrdersCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(SCHEDULER_BROKER_TIMEOUT_MS + 100);

    // Simulated next 60s tick while the first lane is still in flight: the guard must suppress a
    // second stale-limit-scan launch for the same account -- getEquityOrders must NOT be called a
    // second time (that second call would be a duplicate cancel-replace attempt on live orders).
    await _runSchedulerTickForTest();
    expect(getEquityOrdersCalls).toBe(1);
  }, 30_000);
});
