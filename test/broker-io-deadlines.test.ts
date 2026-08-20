import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALPACA_BROKER_IO_DEADLINE_MS, EQUITY_ORDERS_TERMINAL_LOOKBACK_MS } from "../src/lib/inflight-deadline";
import { SCHEDULER_BROKER_TIMEOUT_MS } from "../src/lib/safety-maintenance";

let getOrdersCalls: Array<Record<string, unknown>> = [];
let createOrderHang = false;
let createOrderCalls = 0;
let createOrderSocketFail = false;

vi.mock("@alpacahq/alpaca-trade-api", () => {
  return {
    default: class MockAlpaca {
      async getAccount() {
        return { account_number: "MOCK_ACC", portfolio_value: "50000", buying_power: "25000", equity: "40000", cash: "10000" };
      }
      async getPositions() { return []; }
      async getOrders(opts: Record<string, unknown>) {
        getOrdersCalls.push(opts);
        return [];
      }
      async getLatestQuotes() { return {}; }
      async createOrder() {
        createOrderCalls += 1;
        if (createOrderHang) return new Promise(() => undefined);
        if (createOrderSocketFail) {
          const err = new TypeError("fetch failed");
          (err as Error & { cause?: Error }).cause = Object.assign(new Error("other side closed"), {
            code: "UND_ERR_SOCKET"
          });
          throw err;
        }
        return { id: "ord-1", status: "accepted", filled_qty: "0", filled_avg_price: null };
      }
      async cancelOrder(id: string) {
        if (createOrderHang) return new Promise(() => undefined);
        return { id, status: "cancelled" };
      }
    }
  };
});

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  getOrdersCalls = [];
  createOrderHang = false;
  createOrderCalls = 0;
  createOrderSocketFail = false;
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-broker-io-${randomUUID()}.db`)}`;

  const { upsertConnectedAccount } = await import("../src/lib/db");
  upsertConnectedAccount({
    id: "acc-broker-io",
    userId: "local",
    broker: "alpaca",
    environment: "paper",
    baseUrl: "https://paper-api.alpaca.markets",
    apiKey: "PK_TEST",
    apiSecret: "secret",
    isActive: true,
    label: "Alpaca Paper IO"
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("broker I/O deadlines", () => {
  it("placeEquityOrder rejects when createOrder hangs past the broker I/O deadline", async () => {
    vi.useFakeTimers();
    createOrderHang = true;
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    const pending = gateway.placeEquityOrder({
      accountNumber: "MOCK_ACC",
      symbol: "AAPL",
      side: "buy",
      type: "market",
      quantity: 1,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      refId: "ref-place-timeout"
    });
    pending.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(ALPACA_BROKER_IO_DEADLINE_MS);
    await expect(pending).rejects.toThrow(/timed out/i);
    createOrderHang = false;
  });

  it("placeEquityOrder does not retry createOrder after a dead response socket", async () => {
    createOrderSocketFail = true;
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    await expect(
      gateway.placeEquityOrder({
        accountNumber: "MOCK_ACC",
        symbol: "AAPL",
        side: "buy",
        type: "market",
        quantity: 1,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        refId: "ref-place-socket"
      })
    ).rejects.toThrow(/fetch failed|other side closed|UND_ERR_SOCKET/i);
    expect(createOrderCalls).toBe(1);
    createOrderSocketFail = false;
  });

  it("cancelEquityOrder rejects when cancelOrder hangs past the broker I/O deadline", async () => {
    vi.useFakeTimers();
    createOrderHang = true;
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");

    const pending = gateway.cancelEquityOrder("MOCK_ACC", "order-123");
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(ALPACA_BROKER_IO_DEADLINE_MS);
    await expect(pending).rejects.toThrow(/timed out/i);
    createOrderHang = false;
  });

  it("default getEquityOrders scopes to open plus bounded closed history, not status all", async () => {
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");
    await gateway.getEquityOrders("MOCK_ACC");

    expect(getOrdersCalls.some((c) => c.status === "all")).toBe(false);
    expect(getOrdersCalls.some((c) => c.status === "open")).toBe(true);
    expect(getOrdersCalls.some((c) => c.status === "closed")).toBe(true);
    const closedCall = getOrdersCalls.find((c) => c.status === "closed");
    expect(closedCall?.after).toBeTypeOf("string");
    const afterMs = Date.parse(String(closedCall?.after));
    expect(Date.now() - afterMs).toBeLessThanOrEqual(EQUITY_ORDERS_TERMINAL_LOOKBACK_MS + 5_000);
  });

  it("fullHistory getEquityOrders still walks status all", async () => {
    getOrdersCalls = [];
    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const gateway = getAlpacaGateway("local");
    await gateway.getEquityOrders("MOCK_ACC", { fullHistory: true });
    expect(getOrdersCalls.some((c) => c.status === "all")).toBe(true);
  });

  it("scheduler stop-monitor lane unlatches in-flight key after broker timeout", async () => {
    vi.useFakeTimers();
    const host = globalThis as { __stopMonitorInFlight?: Set<string> };
    host.__stopMonitorInFlight = new Set<string>();

    const { withDeadline, SCHEDULER_BROKER_TIMEOUT_MS: timeoutMs } = await import("../src/lib/safety-maintenance");

    const key = "user:acct";
    host.__stopMonitorInFlight.add(key);

    void withDeadline(new Promise(() => undefined), timeoutMs, "runSyntheticStopMonitor timeout")
      .catch(() => undefined)
      .finally(() => host.__stopMonitorInFlight!.delete(key));

    await vi.advanceTimersByTimeAsync(SCHEDULER_BROKER_TIMEOUT_MS + 10);
    expect(host.__stopMonitorInFlight.has(key)).toBe(false);
  });
});
