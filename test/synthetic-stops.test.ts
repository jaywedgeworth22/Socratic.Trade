import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateStop, runSyntheticStopMonitor } from "../src/lib/synthetic-stops";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import {
  claimSyntheticStop,
  getDb,
  listBrokerProtectiveStops,
  listFillEvents,
  listSyntheticStops,
  revertSyntheticStopClaim,
  upsertBrokerProtectiveStop,
  upsertConnectedAccount,
  upsertSyntheticStop
} from "../src/lib/db";
import { reconcilePendingFills } from "../src/lib/strategy";
import type { BrokerGateway, EquityOrder, TradingPolicy } from "../src/lib/types";

vi.mock("../src/lib/vector-db", () => ({
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => {}
}));

const broker = vi.hoisted(() => ({
  positions: [] as Array<{ symbol: string; quantity: number; averageCost: number; marketValue: number }>,
  quotes: {} as Record<string, { price?: number; bid?: number; ask?: number }>,
  placed: [] as Array<{ side: string; quantity: number; symbol: string; refId: string; type?: string; marketHours?: string; limitPrice?: number; trailPercent?: number }>,
  cancelled: [] as string[],
  orders: [] as Array<{ id: string; symbol: string; side: string; type: string; state: string; quantity?: number; filledQuantity?: number; clientOrderId?: string }>,
  // Broker state returned by placeEquityOrder. "accepted" = the order RESTS (e.g. a market order
  // placed after hours); "filled" = synchronous fill (the Test broker's behavior).
  placeState: "accepted",
  // When set, getEquityOrders throws (broker order list unreadable this tick).
  ordersError: null as Error | null,
  // When set, placeEquityOrder records the placement (the broker ACCEPTED it) and then throws —
  // the "placement threw but the broker may have taken the order" money-path trap.
  placeError: null as Error | null
}));

vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: () => ({
    getPortfolio: async () => ({
      accountNumber: "TEST",
      totalMarketValue: 10000,
      buyingPower: 5000,
      equityMarketValue: 10000,
      optionMarketValue: 0,
      cash: 5000
    }),
    getEquityPositions: async () => broker.positions,
    getEquityOrders: async () => {
      if (broker.ordersError) throw broker.ordersError;
      return broker.orders;
    },
    getEquityQuotes: async () => broker.quotes,
    getEquityTradability: async (_accountNumber: string, symbols: string[]) => Object.fromEntries(
      symbols.map((symbol) => [symbol, { tradable: true, fractional: true }])
    ),
    placeEquityOrder: async (order: { side: string; quantity: number; symbol: string; refId: string; type?: string; marketHours?: string; limitPrice?: number; trailPercent?: number }) => {
      broker.placed.push(order);
      if (broker.placeError) throw broker.placeError;
      return { orderId: `ord-${broker.placed.length}`, refId: order.refId, state: broker.placeState, raw: {} };
    },
    cancelEquityOrder: async (_accountNumber: string, orderId: string) => {
      broker.cancelled.push(orderId);
      return { orderId, refId: "x", state: "cancel_requested", raw: {} };
    }
  })
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-synthstops-${randomUUID()}.db`)}`;
});

const longBase = { side: "long" as const, extremePrice: 100, trailPercent: 5, trailAmount: undefined, lastPrice: 100 };

describe("evaluateStop (synthetic trailing stop)", () => {
  it("raises the extreme as a long climbs and does not trigger above the trail", () => {
    const r = evaluateStop({ ...longBase, extremePrice: 100, lastPrice: 105 }, 110);
    expect(r.newExtreme).toBe(110);
    expect(r.triggerPrice).toBeCloseTo(104.5); // 110 * (1 - 5%)
    expect(r.triggered).toBe(false);
  });

  it("triggers a long when price falls trailPercent below the extreme", () => {
    const r = evaluateStop({ ...longBase, extremePrice: 110, lastPrice: 109 }, 104); // 104 <= 104.5
    expect(r.triggered).toBe(true);
    expect(r.newExtreme).toBe(110); // a pullback never raises the extreme
  });

  it("ignores a bad tick (>10% off last price): no extreme move, no trigger", () => {
    const r = evaluateStop({ ...longBase, extremePrice: 110, lastPrice: 110 }, 60); // -45% spurious print
    expect(r.badTick).toBe(true);
    expect(r.newExtreme).toBe(110);
    expect(r.triggered).toBe(false);
  });

  it("triggers a short when price rises trailPercent above the low extreme", () => {
    const r = evaluateStop({ side: "short", extremePrice: 100, trailPercent: 5, trailAmount: undefined, lastPrice: 101 }, 106);
    expect(r.triggerPrice).toBeCloseTo(105); // 100 * (1 + 5%)
    expect(r.triggered).toBe(true);
  });

  it("lowers the extreme as a short falls and supports an absolute trail amount", () => {
    const r = evaluateStop({ side: "short", extremePrice: 100, trailPercent: undefined, trailAmount: 3, lastPrice: 99 }, 95);
    expect(r.newExtreme).toBe(95); // a short's extreme tracks DOWN
    expect(r.triggerPrice).toBeCloseTo(98); // 95 + 3
    expect(r.triggered).toBe(false); // 95 < 98, not yet
  });
});

describe("runSyntheticStopMonitor (orchestration)", () => {
  function policyFor(account: string): TradingPolicy {
    return {
      ...DEFAULT_POLICY,
      accountNumber: account,
      systemState: "active",
      shortSellingEnabled: true,
      additionalSymbols: ["AAPL", "TSLA", "NVDA"],
      riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 5 }
    };
  }

  // An account is an account: runSyntheticStopMonitor derives its execution mode from the real
  // connected account's own `environment` (getActiveConnectedAccount) — there is no local-simulation
  // fallback. getBrokerGateway itself is mocked above, but the account lookup is real DB state, so
  // every test needs a matching connected TEST-BROKER account (test infrastructure) wired up first.
  function connectTestAccount(accountNumber: string, environment: "paper" | "live" = "paper"): void {
    upsertConnectedAccount({
      id: `acct-${accountNumber}`,
      userId: "local",
      broker: "test",
      environment,
      accountNumber,
      label: accountNumber,
      isActive: true
    });
  }

  beforeEach(() => {
    broker.positions = [];
    broker.quotes = {};
    broker.placed = [];
    broker.cancelled = [];
    broker.orders = [];
    broker.placeState = "accepted";
    broker.ordersError = null;
    broker.placeError = null;
  });

  /** Audit receipts of one kind for one symbol (payloads are JSON with a `symbol` field). */
  function auditPayloads(kind: string, symbol: string): Array<Record<string, unknown>> {
    const rows = getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = ? ORDER BY created_at ASC")
      .all(kind) as Array<{ payload: string }>;
    return rows
      .map((r) => JSON.parse(r.payload) as Record<string, unknown>)
      .filter((p) => p.symbol === symbol);
  }

  it("auto-registers and fires a SELL to exit a long when the trail breaches (running)", async () => {
    broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { AAPL: { price: 90 } }; // extreme 100, trail 5% → trigger ≤95; 90 breaches
    connectTestAccount("SYN-LONG");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-LONG"), true);
    expect(result.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("sell");
    expect(broker.placed[0].quantity).toBe(10);
  });

  it("fires a COVER to exit a short when the trail breaches (running)", async () => {
    broker.positions = [{ symbol: "TSLA", quantity: -5, averageCost: 100, marketValue: -500 }];
    broker.quotes = { TSLA: { price: 110 } }; // short extreme 100, trail 5% → trigger ≥105; 110 breaches
    connectTestAccount("SYN-SHORT");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-SHORT"), true);
    expect(result.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("cover");
    expect(broker.placed[0].quantity).toBe(5);
  });

  it("suppresses the exit order when not running (would-trigger only)", async () => {
    broker.positions = [{ symbol: "TSLA", quantity: -5, averageCost: 100, marketValue: -500 }];
    broker.quotes = { TSLA: { price: 110 } };
    connectTestAccount("SYN-SUPPRESS");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-SUPPRESS"), false);
    expect(result.triggered).toBe(1);
    expect(result.exited).toBe(0);
    expect(broker.placed).toHaveLength(0);
  });

  it("does NOT auto-register a synthetic stop when a broker-held stop already rests for the symbol", async () => {
    broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { AAPL: { price: 90 } }; // would breach a 5% trail off extreme 100 IF registered
    broker.orders = [{ id: "oco-stop-1", symbol: "AAPL", side: "sell", type: "stop", state: "new" }];
    connectTestAccount("SYN-BRACKET");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-BRACKET"), true);
    // The broker bracket owns the exit — no synthetic stop registered, so nothing evaluated/fired.
    expect(result.exited).toBe(0);
    expect(broker.placed).toHaveLength(0);
  });

  it.each(["queued", "confirmed", "unconfirmed"])(
    "treats a RESTING Robinhood broker stop (state=%s) as protection → no duplicate synthetic exit",
    async (rhState) => {
      // Regression for the double-exit hazard: a Robinhood broker-held protective stop rests in
      // queued/confirmed/unconfirmed (not Alpaca's new/accepted). Before the fix those states were
      // unrecognized, so the monitor didn't see the broker stop, auto-registered a synthetic trailing
      // stop, and could market-sell on top of the resting broker stop. It must now skip the symbol.
      broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
      broker.quotes = { AAPL: { price: 90 } }; // would breach a 5% trail off extreme 100 IF registered
      broker.orders = [{ id: "rh-stop-1", symbol: "AAPL", side: "sell", type: "stop_market", state: rhState }];
      connectTestAccount(`SYN-RH-${rhState}`, "live");
      const result = await runSyntheticStopMonitor("local", policyFor(`SYN-RH-${rhState}`), true);
      // The resting RH broker stop owns the exit — no synthetic stop registered, nothing fired.
      expect(result.exited).toBe(0);
      expect(broker.placed).toHaveLength(0);
    }
  );

  it("still auto-registers when the only broker stop for the symbol is terminal (canceled)", async () => {
    broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { AAPL: { price: 90 } };
    broker.orders = [{ id: "dead", symbol: "AAPL", side: "sell", type: "stop", state: "canceled" }];
    connectTestAccount("SYN-CANCELED");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-CANCELED"), true);
    // A canceled broker stop no longer protects → the synthetic must take over and fire.
    expect(result.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("sell");
  });

  it("a FULL-size live broker stop suppresses registration via quantity-aware coverage", async () => {
    broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { AAPL: { price: 90 } };
    // Explicit quantity == position: coverage (not any symbol-level shortcut) is what suppresses.
    broker.orders = [{ id: "rh-full", symbol: "AAPL", side: "sell", type: "stop_market", state: "queued", quantity: 10 }];
    connectTestAccount("SYN-FULLSTOP", "live");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-FULLSTOP"), true);
    expect(result.exited).toBe(0);
    expect(broker.placed).toHaveLength(0);
    expect(listSyntheticStops("SYN-FULLSTOP", "local")).toHaveLength(0);
  });

  it("a PARTIAL-size live broker stop no longer suppresses protection for the uncovered shares", async () => {
    broker.positions = [{ symbol: "MU", quantity: 100, averageCost: 100, marketValue: 10000 }];
    broker.quotes = { MU: { price: 90 } }; // breaches a 5% trail off extreme 100
    // A live broker stop covering only 40 of the 100 shares (e.g. an owner-placed manual RH stop).
    // The old symbol-level "has a live stop" guard was quantity-blind and suppressed registration
    // entirely — 60 shares rode through a crash unprotected. Coverage must register the synthetic
    // and fire it for exactly the uncovered remainder.
    broker.orders = [{ id: "rh-part", symbol: "MU", side: "sell", type: "stop_market", state: "queued", quantity: 40 }];
    connectTestAccount("SYN-PARTSTOP", "live");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-PARTSTOP"), true);
    expect(result.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("sell");
    expect(broker.placed[0].quantity).toBe(60);
  });

  it("a live stop-BUY (entry/add-on) is NOT protection for a long — the synthetic registers and fires", async () => {
    broker.positions = [{ symbol: "MU", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { MU: { price: 90 } };
    // A stop-entry BUY above the market on a symbol we're long. The old symbol-level guard was
    // side-blind — any live /stop/i order marked the symbol broker-protected. A buy can never exit
    // a long, so it must not suppress the trailing stop.
    broker.orders = [{ id: "buystop-1", symbol: "MU", side: "buy", type: "stop_market", state: "queued", quantity: 5 }];
    connectTestAccount("SYN-BUYSTOP", "live");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-BUYSTOP"), true);
    expect(result.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("sell");
    expect(broker.placed[0].quantity).toBe(10);
  });

  it("disabled-teardown tick: the just-cancelled broker stop is pruned, so the synthetic registers the SAME tick", async () => {
    broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { AAPL: { price: 90 } };
    // The RH protective stop the feature placed while it was ON — the order list is fetched BEFORE
    // reconcile runs, so this tick it still shows the stop as live even after the teardown cancels it.
    broker.orders = [{ id: "prot-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "queued", quantity: 10 }];
    upsertBrokerProtectiveStop({
      id: "protstop-local-SYN-TEARDOWN-AAPL", userId: "local", accountNumber: "SYN-TEARDOWN",
      symbol: "AAPL", brokerOrderId: "prot-1", quantity: 10, stopPrice: 92, status: "resting"
    });
    connectTestAccount("SYN-TEARDOWN", "live");
    // policyFor leaves robinhoodBrokerStops at its default (off) → reconcile tears the stop down mid-tick.
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-TEARDOWN"), true);
    expect(broker.cancelled).toEqual(["prot-1"]); // the teardown actually cancelled it
    // The cancelled stop must NOT suppress auto-registration — the position would otherwise carry
    // NEITHER protection until the next tick. The synthetic row exists (armed) this same tick.
    expect(listSyntheticStops("SYN-TEARDOWN", "local")).toHaveLength(1);
    // The FIRE path deliberately still honors the stale order for this one tick (a cancel the
    // broker merely accepted can still fill) — no exit stacks on it.
    expect(result.exited).toBe(0);
    expect(broker.placed).toHaveLength(0);
    // Next tick the broker's list no longer shows the cancelled stop: the armed synthetic takes over.
    broker.orders = [];
    const second = await runSyntheticStopMonitor("local", policyFor("SYN-TEARDOWN"), true);
    expect(second.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0]).toMatchObject({ side: "sell", quantity: 10 });
  });

  it("mismatch cancel/REPLACE tick: the just-placed replacement stop defers registration — no same-tick fire, replacement never cancelled", async () => {
    broker.positions = [{ symbol: "MU", quantity: 100, averageCost: 100, marketValue: 10000 }];
    broker.quotes = { MU: { price: 90 } }; // would breach a 5% trail off extreme 100 IF a synthetic registered
    // A tracked-but-undersized RH broker stop (position grew 40 -> 100 since it was placed). The
    // monitor's order list is fetched BEFORE reconcile runs, so this tick it still shows only the
    // stale 40-share stop — and can never show the full-size replacement reconcile places mid-tick.
    broker.orders = [{ id: "prot-old", symbol: "MU", side: "sell", type: "stop_market", state: "queued", quantity: 40 }];
    upsertBrokerProtectiveStop({
      id: "protstop-local-SYN-REPLACE-MU", userId: "local", accountNumber: "SYN-REPLACE",
      symbol: "MU", brokerOrderId: "prot-old", quantity: 40, stopPrice: 92, status: "resting"
    });
    connectTestAccount("SYN-REPLACE", "live");
    const policy: TradingPolicy = {
      ...policyFor("SYN-REPLACE"),
      activeBroker: "robinhood",
      robinhoodBrokerStops: true,
      riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 5, stopLossPct: 8 }
    };
    const result = await runSyntheticStopMonitor("local", policy, true);
    // Reconcile cancelled the mismatched stop and placed a full-size replacement mid-tick...
    expect(broker.cancelled).toEqual(["prot-old"]); // ...and the replacement (ord-1) was NOT cancelled
    expect(broker.placed).toHaveLength(1); // ONLY reconcile's replacement — no synthetic market sell
    expect(broker.placed[0]).toMatchObject({ side: "sell", quantity: 100 });
    // Before the fix: registration coverage (pruned of prot-old, blind to the just-placed ord-1)
    // saw 0 covered shares, registered the synthetic, fired a 60-share market sell against the
    // stale 40-share coverage, and cancelBrokerProtectiveStop then cancelled the fresh full-size
    // replacement — shares double-sold AND the remainder left unprotected until the re-arm grace.
    // Now: the just-placed symbol is broker-covered for THIS tick's registration; nothing fires.
    expect(result.exited).toBe(0);
    expect(listSyntheticStops("SYN-REPLACE", "local")).toHaveLength(0); // registration deferred
    expect(listSyntheticStops("SYN-REPLACE", "local", "triggered")).toHaveLength(0);

    // Next tick: the fresh order fetch sees the replacement resting full-size — normal
    // quantity-aware coverage suppresses registration; nothing new placed or cancelled.
    broker.orders = [{ id: "ord-1", symbol: "MU", side: "sell", type: "stop_market", state: "queued", quantity: 100 }];
    const second = await runSyntheticStopMonitor("local", policy, true);
    expect(second.exited).toBe(0);
    expect(broker.placed).toHaveLength(1);
    expect(broker.cancelled).toEqual(["prot-old"]);
    expect(listSyntheticStops("SYN-REPLACE", "local")).toHaveLength(0);
  });

  it("ACTIVE row + broker stop placed the SAME tick: the fire defers — no exit on top of the fresh stop, stop never cancelled", async () => {
    // An already-armed synthetic row (e.g. registered on an earlier tick where section-4 placement
    // threw, or armed before robinhoodBrokerStops was enabled). THIS tick reconcile PLACES the
    // broker stop and the quote breaches the trail. The fire loop's coverage comes from the
    // pre-reconcile order list, which can never contain the just-placed stop — before the fix it
    // fired a full-size market sell on top of it and cancelBrokerProtectiveStop then cancelled the
    // fresh stop after booking the fill (duplicate exit, then no protection).
    upsertSyntheticStop({
      id: "stop-justplaced", userId: "local", accountNumber: "SYN-JUSTPLACED", symbol: "JPLC",
      side: "long", quantity: 100, entryPrice: 100, extremePrice: 100, trailPercent: 5, status: "active"
    });
    broker.positions = [{ symbol: "JPLC", quantity: 100, averageCost: 100, marketValue: 10000 }];
    broker.quotes = { JPLC: { price: 90 } }; // breaches the 5% trail off extreme 100
    broker.orders = []; // pre-reconcile list: nothing resting yet (the stop is placed mid-tick)
    connectTestAccount("SYN-JUSTPLACED", "live");
    const policy: TradingPolicy = {
      ...policyFor("SYN-JUSTPLACED"),
      activeBroker: "robinhood",
      robinhoodBrokerStops: true,
      riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 5, stopLossPct: 8 }
    };
    const result = await runSyntheticStopMonitor("local", policy, true);
    expect(broker.placed).toHaveLength(1); // ONLY reconcile's stop_market placement
    expect(broker.placed[0]).toMatchObject({ side: "sell", type: "stop_market", quantity: 100 });
    expect(result.triggered).toBe(1); // the trail did breach…
    expect(result.exited).toBe(0); // …but nothing fired on top of the fresh full-size stop
    expect(broker.cancelled).toEqual([]); // the fresh broker stop was NOT cancelled
    expect(listSyntheticStops("SYN-JUSTPLACED", "local")).toHaveLength(1); // stays armed, not claimed
    expect(listSyntheticStops("SYN-JUSTPLACED", "local", "triggered")).toHaveLength(0);
    const receipts = auditPayloads("synthetic_stop_skipped_resting_exit", "JPLC");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].note).toContain("placed this tick");

    // Next tick: the fresh order fetch shows the full-size stop resting — normal quantity-aware
    // coverage suppresses the fire; nothing new placed, still nothing cancelled.
    broker.orders = [{ id: "ord-1", symbol: "JPLC", side: "sell", type: "stop_market", state: "queued", quantity: 100 }];
    const second = await runSyntheticStopMonitor("local", policy, true);
    expect(second.exited).toBe(0);
    expect(broker.placed).toHaveLength(1);
    expect(broker.cancelled).toEqual([]);
    expect(listSyntheticStops("SYN-JUSTPLACED", "local")).toHaveLength(1);
  });

  it("registration folds a SAME-TICK PARTIAL broker-stop placement into coverage — no needless synthetic row when combined coverage is already full (Codex review, PR #1331)", async () => {
    // 100-share long already 40-covered by a manual live sell. Reconcile places a broker-held
    // trailing stop for the true 60-share remainder — a PARTIAL placement (60 < 100). The order list
    // is fetched BEFORE reconcile runs, so it can only ever show the 40-share order, never the fresh
    // 60-share stop. Registration coverage therefore sees only 40/100. Before the fix that undercount
    // armed a needless full-size synthetic row for an already-fully-covered position (40 manual + 60
    // broker = 100) — a stale row that then over-sells on a later tick where the order fetch fails.
    // The fix folds the just-placed partial quantity into registration coverage, exactly as the fire
    // path already does. Mark is held AT entry (no trail breach) so this isolates the REGISTRATION
    // decision from any firing.
    broker.positions = [{ symbol: "MU", quantity: 100, averageCost: 100, marketValue: 10000 }]; // mark == entry (100)
    broker.quotes = { MU: { price: 100 } };
    broker.orders = [{ id: "manual-sell", symbol: "MU", side: "sell", type: "limit", state: "queued", quantity: 40 }];
    connectTestAccount("SYN-REG-PARTIAL", "live");
    const policy: TradingPolicy = {
      ...policyFor("SYN-REG-PARTIAL"),
      activeBroker: "robinhood",
      robinhoodBrokerStops: true,
      riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 5, stopLossPct: 8 }
    };
    const result = await runSyntheticStopMonitor("local", policy, true);
    // Reconcile placed exactly the 60-share partial broker stop (100 position - 40 already covered).
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0]).toMatchObject({ side: "sell", quantity: 60 });
    // The fix: 40 (manual) + 60 (just-placed partial) == 100 fully covers the position, so NO
    // synthetic row is registered. Before the fix, registration saw only 40/100 and armed one.
    expect(listSyntheticStops("SYN-REG-PARTIAL", "local")).toHaveLength(0);
    expect(result.exited).toBe(0);
  });

  it("a PARTIAL synthetic fire (uncovered remainder) does NOT cancel the still-valid broker stop covering the rest of the position", async () => {
    // A fractional long (10.6 sh) whose whole-share portion is already protected by a native Alpaca
    // trailing stop placed on an earlier tick (floored to 10 sh — Alpaca rejects fractional trailing
    // stops); the 0.6-sh remainder has no broker-held coverage. Modeled directly as "tick 2" state
    // (the resting stop + an already-armed synthetic row) so this test isolates the FIRE loop's
    // cancel decision from reconcile's own same-tick placement/coverage bookkeeping.
    broker.positions = [{ symbol: "AAPL", quantity: 10.6, averageCost: 100, marketValue: 10.6 * 90 }];
    broker.quotes = { AAPL: { price: 90 } }; // breaches a 5% trail off the seeded extreme (100)
    broker.orders = [{ id: "trail-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "queued", quantity: 10 }];
    upsertBrokerProtectiveStop({
      id: "protstop-local-SYN-PARTIALFIRE-AAPL", userId: "local", accountNumber: "SYN-PARTIALFIRE",
      symbol: "AAPL", brokerOrderId: "trail-1", quantity: 10, stopPrice: 95, status: "resting",
      kind: "trailing", trailPercent: 5
    });
    upsertSyntheticStop({
      id: "synstop-local-SYN-PARTIALFIRE-AAPL", userId: "local", accountNumber: "SYN-PARTIALFIRE",
      symbol: "AAPL", side: "long", quantity: 10.6, entryPrice: 100, extremePrice: 100, trailPercent: 5, status: "active"
    });
    connectTestAccount("SYN-PARTIALFIRE", "paper");
    const policy: TradingPolicy = {
      ...policyFor("SYN-PARTIALFIRE"),
      activeBroker: "alpaca",
      riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 5 }
    };
    const result = await runSyntheticStopMonitor("local", policy, true);
    // Reconcile is a no-op this tick — the existing 10-sh trailing stop already matches what it
    // would place (no mismatch, no re-cancel/replace) — so the only placeEquityOrder call is the
    // fire loop's own protective exit, sized to the 0.6-sh uncovered remainder.
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("sell");
    expect(broker.placed[0].quantity).toBeCloseTo(0.6);
    expect(result.exited).toBe(1);
    const fills = listFillEvents("SYN-PARTIALFIRE", "paper", 10, "local");
    expect(fills).toHaveLength(1);
    expect(fills[0].quantity).toBeCloseTo(0.6);
    // ...and — the fix under test — must NOT cancel the broker-held stop still covering the other
    // 10 shares: before the fix, cancelBrokerProtectiveStop ran unconditionally after every fire.
    expect(broker.cancelled).toEqual([]);
    const stops = listBrokerProtectiveStops("SYN-PARTIALFIRE", "local");
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ brokerOrderId: "trail-1", status: "resting", quantity: 10 });
  });

  it("books a LIVE stop exit as pending_reconciliation (provisional at quote price, not a final fill)", async () => {
    broker.positions = [{ symbol: "NVDA", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { NVDA: { price: 90 } }; // breaches a 5% trail off extreme 100
    connectTestAccount("SYN-LIVE", "live");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-LIVE"), true);
    expect(result.exited).toBe(1);
    const fills = listFillEvents("SYN-LIVE", "live", 10, "local");
    expect(fills).toHaveLength(1);
    expect(fills[0].status).toBe("pending_reconciliation"); // reconcilePendingFills books the real fill
    expect(fills[0].brokerOrderId).toBe("ord-1");
  });

  // ── Regressions for the 2026-07-08 overnight MU incident (Alpaca paper) ─────────────

  it("books an after-hours PAPER exit as pending (not filled-at-quote) and reconciliation finalizes the true fill", async () => {
    broker.positions = [{ symbol: "MU", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { MU: { price: 90 } }; // breaches a 5% trail off extreme 100
    broker.placeState = "accepted"; // the market sell RESTS at the broker until the next open
    connectTestAccount("SYN-AFTERHOURS");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-AFTERHOURS"), true);
    expect(result.exited).toBe(1);
    let fills = listFillEvents("SYN-AFTERHOURS", "paper", 10, "local");
    expect(fills).toHaveLength(1);
    // The incident booked this as status "filled" at the placement-time quote — realized P&L was
    // fabricated hours before the true open fill. It must sit pending until the broker reports it.
    expect(fills[0].status).toBe("pending_reconciliation");
    expect(fills[0].brokerOrderId).toBe("ord-1");

    // Next morning: the resting order fills at the open — the EXISTING reconciliation path books it.
    const openFillGateway = {
      getEquityOrders: async () => [{
        id: "ord-1",
        symbol: "MU",
        side: "sell",
        type: "market",
        state: "filled",
        filledQuantity: 10,
        averagePrice: 93.85,
        createdAt: new Date().toISOString(),
        updatedAt: "2026-07-08T13:30:05.000Z"
      } as EquityOrder]
    } as unknown as BrokerGateway;
    await reconcilePendingFills(openFillGateway, "SYN-AFTERHOURS", "local");
    fills = listFillEvents("SYN-AFTERHOURS", "paper", 10, "local");
    expect(fills[0].status).toBe("filled");
    expect(fills[0].price).toBe(93.85); // the true open fill, not the after-hours quote
    expect(fills[0].notional).toBeCloseTo(938.5);
    expect(fills[0].filledAt).toBe("2026-07-08T13:30:05.000Z");
  });

  it("does NOT re-arm or re-fire a triggered stop while its exit order is still resting", async () => {
    broker.positions = [{ symbol: "MU", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { MU: { price: 90 } };
    connectTestAccount("SYN-REFIRE");
    const first = await runSyntheticStopMonitor("local", policyFor("SYN-REFIRE"), true);
    expect(first.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    // The exit rests at the broker all night, visible as a live open MARKET order.
    broker.orders = [{ id: "ord-1", symbol: "MU", side: "sell", type: "market", state: "new" }];
    // Next tick (and every ~60s all night in the incident): must not fire again.
    const second = await runSyntheticStopMonitor("local", policyFor("SYN-REFIRE"), true);
    expect(second.exited).toBe(0);
    expect(broker.placed).toHaveLength(1); // no duplicate protective sell
    expect(listSyntheticStops("SYN-REFIRE", "local", "triggered")).toHaveLength(1); // still claimed
    expect(listSyntheticStops("SYN-REFIRE", "local")).toHaveLength(0); // never resurrected to active
  });

  it("treats a resting NON-STOP exit order (limit sell) as protection — nothing registered or fired on top of it", async () => {
    broker.positions = [{ symbol: "MU", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { MU: { price: 90 } }; // would breach a 5% trail IF a stop were registered
    broker.orders = [{ id: "lim-1", symbol: "MU", side: "sell", type: "limit", state: "new" }];
    connectTestAccount("SYN-LIMIT");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-LIMIT"), true);
    expect(result.exited).toBe(0);
    expect(broker.placed).toHaveLength(0);
    expect(listSyntheticStops("SYN-LIMIT", "local")).toHaveLength(0); // registration deferred, not stacked
  });

  it("does not fire an ACTIVE stop on top of a resting exit order (fire-path protection check)", async () => {
    connectTestAccount("SYN-SKIPFIRE");
    upsertSyntheticStop({
      id: "stop-skipfire", userId: "local", accountNumber: "SYN-SKIPFIRE", symbol: "MU",
      side: "long", quantity: 10, entryPrice: 100, extremePrice: 100, trailPercent: 5, status: "active"
    });
    broker.positions = [{ symbol: "MU", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { MU: { price: 90 } };
    broker.orders = [{ id: "lim-2", symbol: "MU", side: "sell", type: "limit", state: "new" }];
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-SKIPFIRE"), true);
    expect(result.triggered).toBe(1); // the trail breached…
    expect(result.exited).toBe(0); // …but no order is stacked on the resting exit
    expect(broker.placed).toHaveLength(0);
    expect(listSyntheticStops("SYN-SKIPFIRE", "local")).toHaveLength(1); // stays active/armed, not claimed
  });

  it("upsertSyntheticStop cannot resurrect a 'triggered' row to 'active' (revertSyntheticStopClaim is the only re-arm path)", () => {
    const stop = {
      id: "stop-resurrect", userId: "local", accountNumber: "SYN-UPS", symbol: "MU",
      side: "long" as const, quantity: 10, entryPrice: 100, extremePrice: 100, trailPercent: 5,
      status: "active" as const
    };
    upsertSyntheticStop(stop);
    expect(claimSyntheticStop("stop-resurrect", "local")).toBe(true);
    upsertSyntheticStop(stop); // the incident's auto-register overwrite (status: "active")
    expect(listSyntheticStops("SYN-UPS", "local", "triggered")).toHaveLength(1); // guard held
    expect(listSyntheticStops("SYN-UPS", "local")).toHaveLength(0);
    revertSyntheticStopClaim("stop-resurrect", "local"); // the deliberate confirmed-terminal path
    expect(listSyntheticStops("SYN-UPS", "local")).toHaveLength(1);
  });

  it("re-arms and re-fires under a FRESH refId once the exit order is confirmed dead with the position still open", async () => {
    broker.positions = [{ symbol: "MU", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { MU: { price: 90 } };
    connectTestAccount("SYN-REARM");
    const first = await runSyntheticStopMonitor("local", policyFor("SYN-REARM"), true);
    expect(first.exited).toBe(1);
    // The resting exit later dies unfilled — reconciliation confirms it terminal.
    const expiredGateway = {
      getEquityOrders: async () => [{
        id: "ord-1", symbol: "MU", side: "sell", type: "market", state: "expired",
        createdAt: new Date().toISOString()
      } as EquityOrder]
    } as unknown as BrokerGateway;
    await reconcilePendingFills(expiredGateway, "SYN-REARM", "local");
    expect(listFillEvents("SYN-REARM", "paper", 10, "local")[0].status).toBe("expired");
    // Age the triggered row past the re-arm confirmation grace window.
    getDb()
      .prepare("UPDATE synthetic_trailing_stops SET updated_at = ? WHERE account_number = ? AND user_id = ?")
      .run(new Date(Date.now() - 16 * 60_000).toISOString(), "SYN-REARM", "local");
    broker.orders = [{ id: "ord-1", symbol: "MU", side: "sell", type: "market", state: "expired" }];
    const second = await runSyntheticStopMonitor("local", policyFor("SYN-REARM"), true);
    // Protection restored: still breached, so a fresh exit fires — under a NEW client order id,
    // so the broker's client_order_id uniqueness cannot 422 the legitimate replacement. The id
    // rolls forward via the per-row fire generation ("-g1"), persisted on the stop itself.
    expect(second.exited).toBe(1);
    expect(broker.placed).toHaveLength(2);
    expect(broker.placed[1].refId).not.toBe(broker.placed[0].refId);
    expect(broker.placed[1].refId).toBe(`${broker.placed[0].refId}-g1`);
    const rowAfter = listSyntheticStops("SYN-REARM", "local", "triggered")[0];
    expect(rowAfter.fireGeneration).toBe(1);
    expect(rowAfter.lastAttemptRefId).toBe(broker.placed[1].refId);
  });

  it("re-arms the remainder's own dead exit even while an UNRELATED broker-held stop is still live for the same symbol (Codex review, PR #1331, round 7)", async () => {
    // Alpaca native trailing floors to whole shares — 10.6 shares gets a 10-share resting native
    // trail (placed by reconcile) PLUS the synthetic monitor firing its own market sell for the
    // 0.6-share uncovered remainder (round 6's fix). If that remainder order later dies, re-arm
    // must not be blocked just because the (unrelated, still perfectly valid) 10-share trail is
    // still live — a quantity-blind "anything live for this symbol" check would wrongly conflate
    // the two and leave the remainder permanently unprotected.
    broker.positions = [{ symbol: "AAPL", quantity: 10.6, averageCost: 100, marketValue: 1060 }];
    broker.quotes = { AAPL: { price: 90 } };
    connectTestAccount("SYN-REARM-PARTIAL");
    const alpacaPolicy = { ...policyFor("SYN-REARM-PARTIAL"), activeBroker: "alpaca" as const };
    const first = await runSyntheticStopMonitor("local", alpacaPolicy, true);
    expect(first.exited).toBe(1);
    expect(broker.placed).toHaveLength(2); // [0] native trail (10 sh), [1] market sell (0.6 sh remainder)
    const trailOrderId = "ord-1";
    const remainderRefId = broker.placed[1].refId;

    // The remainder's market sell later EXPIRES (never filled) — reconcile that to a terminal status.
    const expiredGateway = {
      getEquityOrders: async () => [
        { id: trailOrderId, symbol: "AAPL", side: "sell", type: "stop_market", state: "new", quantity: 10, createdAt: new Date().toISOString() },
        { id: "ord-2", symbol: "AAPL", side: "sell", type: "market", state: "expired", clientOrderId: remainderRefId, createdAt: new Date().toISOString() }
      ] as EquityOrder[]
    } as unknown as BrokerGateway;
    await reconcilePendingFills(expiredGateway, "SYN-REARM-PARTIAL", "local");

    // Age the triggered row past the re-arm confirmation grace window.
    getDb()
      .prepare("UPDATE synthetic_trailing_stops SET updated_at = ? WHERE account_number = ? AND user_id = ?")
      .run(new Date(Date.now() - 16 * 60_000).toISOString(), "SYN-REARM-PARTIAL", "local");

    // Next tick: the native trail (10 sh) is STILL resting/live, but the remainder's own order is
    // confirmed dead — re-arm must succeed despite the trail's continued presence.
    broker.orders = [
      { id: trailOrderId, symbol: "AAPL", side: "sell", type: "stop_market", state: "new", quantity: 10 },
      { id: "ord-2", symbol: "AAPL", side: "sell", type: "market", state: "expired", clientOrderId: remainderRefId }
    ];
    const second = await runSyntheticStopMonitor("local", alpacaPolicy, true);
    expect(second.exited).toBe(1); // re-armed AND re-fired for the still-uncovered 0.6-share remainder
    const rowAfter = listSyntheticStops("SYN-REARM-PARTIAL", "local", "triggered")[0];
    expect(rowAfter.fireGeneration).toBe(1);
    expect(rowAfter.lastAttemptRefId).not.toBe(remainderRefId);
  });

  // ── Round 2 (adversarial review): per-row fire_generation / last_attempt_ref_id ─────

  it("reverted-after-throw path: reuses the SAME refId while ambiguous and advances to -g1 only after confirmed-terminal", async () => {
    broker.positions = [{ symbol: "MU", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { MU: { price: 90 } };
    connectTestAccount("SYN-THROW");

    // Tick 1: the broker ACCEPTS the market sell but the placement call throws (response lost).
    // No fill is booked, the claim reverts — but the attempted client_order_id must be remembered.
    broker.placeError = new Error("socket hang up");
    const first = await runSyntheticStopMonitor("local", policyFor("SYN-THROW"), true);
    expect(first.exited).toBe(0);
    expect(broker.placed).toHaveLength(1);
    const r0 = broker.placed[0].refId;
    expect(r0).not.toContain("-g"); // generation 0 keeps the original unsuffixed id format
    expect(listFillEvents("SYN-THROW", "paper", 10, "local")).toHaveLength(0); // nothing booked
    let row = listSyntheticStops("SYN-THROW", "local")[0]; // reverted to active…
    expect(row.lastAttemptRefId).toBe(r0); // …but the possibly-live order's id is remembered
    expect(row.fireGeneration).toBe(0);

    // Tick 2: the order list is UNREADABLE — the prior order's fate is ambiguous, so the retry
    // must reuse the exact same client_order_id (a 422 collision fails safe; a fresh id could
    // double-sell on top of an order the broker actually took).
    broker.ordersError = new Error("504 gateway timeout");
    await runSyntheticStopMonitor("local", policyFor("SYN-THROW"), true);
    expect(broker.placed).toHaveLength(2);
    expect(broker.placed[1].refId).toBe(r0); // verbatim reuse — generation did NOT advance
    expect(listSyntheticStops("SYN-THROW", "local")[0].fireGeneration).toBe(0);

    // Tick 3: the order list is readable and POSITIVELY shows the prior attempt dead (no live
    // exit order, r0's client_order_id nowhere live, no fill pending). Only now does the
    // generation advance and the replacement place under a fresh "-g1" id.
    broker.ordersError = null;
    broker.placeError = null;
    broker.orders = [];
    const third = await runSyntheticStopMonitor("local", policyFor("SYN-THROW"), true);
    expect(third.exited).toBe(1);
    expect(broker.placed).toHaveLength(3);
    expect(broker.placed[2].refId).toBe(`${r0}-g1`);
    row = listSyntheticStops("SYN-THROW", "local", "triggered")[0];
    expect(row.fireGeneration).toBe(1);
    expect(row.lastAttemptRefId).toBe(`${r0}-g1`);
  });

  // ── Extended-hours routing (allowExtendedHoursSyntheticStops) — PR #1228 review regressions ──

  it("anchors the extended-hours SELL exit limit to the BID, not the ask-biased composite price", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z")); // 08:00 ET = pre-market (EDT)
    try {
      broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
      // bid 89.5 / ask 90: the composite price is the ASK (Alpaca sets price = ask ?? bid). A limit
      // off the composite (89.87) would sit ABOVE the 89.5 bid — resting, not marketable.
      broker.quotes = { AAPL: { price: 90, bid: 89.5, ask: 90 } };
      connectTestAccount("SYN-EXTHOURS");
      const policy = { ...policyFor("SYN-EXTHOURS"), allowExtendedHoursSyntheticStops: true };
      const result = await runSyntheticStopMonitor("local", policy, true);
      expect(result.exited).toBe(1);
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0]).toMatchObject({
        side: "sell",
        type: "limit",
        marketHours: "extended_hours",
        limitPrice: 89.36 // 89.5 * (1 - 0.0015) = 89.36575, bid-anchored, rounded OUTWARD (down) to stay marketable
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a FRACTIONAL extended-hours exit as a regular-hours market order (queues to the open instead of being hard-blocked)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z")); // 08:00 ET = pre-market (EDT)
    try {
      broker.positions = [{ symbol: "AAPL", quantity: 10.5, averageCost: 100, marketValue: 1050 }];
      broker.quotes = { AAPL: { price: 90, bid: 89.5, ask: 90 } };
      connectTestAccount("SYN-EXTFRAC");
      const policy = { ...policyFor("SYN-EXTFRAC"), allowExtendedHoursSyntheticStops: true };
      const result = await runSyntheticStopMonitor("local", policy, true);
      // Before the quantity guard this became a fractional extended_hours limit, which policy
      // hard-blocks ("Fractional or dollar-based orders must be regular-hours only.") — leaving the
      // breached position with NO protective order at all for the rest of the extended session.
      expect(result.exited).toBe(1);
      expect(broker.placed).toHaveLength(1);
      expect(broker.placed[0]).toMatchObject({
        side: "sell",
        quantity: 10.5,
        type: "market",
        marketHours: "regular_hours"
      });
      expect(broker.placed[0].limitPrice).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("partial coverage: a 10-of-100-share resting trim leaves 90 shares protected — the stop fires for the UNCOVERED remainder", async () => {
    broker.positions = [{ symbol: "MU", quantity: 100, averageCost: 100, marketValue: 10000 }];
    broker.quotes = { MU: { price: 90 } }; // breaches a 5% trail off extreme 100
    // A live GTC take-profit trim for 10 of the 100 shares. Before quantity-aware coverage, ANY
    // live sell suppressed registration AND firing — 90 shares rode through a crash unprotected.
    broker.orders = [{ id: "trim-1", symbol: "MU", side: "sell", type: "limit", state: "new", quantity: 10 }];
    connectTestAccount("SYN-PARTIAL");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-PARTIAL"), true);
    expect(result.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("sell");
    expect(broker.placed[0].quantity).toBe(90); // only the shares the trim does NOT already cover
  });

  it("partial coverage counts REMAINING quantity: a partially filled trim covers only its open shares", async () => {
    broker.positions = [{ symbol: "MU", quantity: 100, averageCost: 100, marketValue: 10000 }];
    broker.quotes = { MU: { price: 90 } };
    // 20-share trim, 5 already filled → 15 still resting; the stop must fire for the other 85.
    broker.orders = [{ id: "trim-2", symbol: "MU", side: "sell", type: "limit", state: "partially_filled", quantity: 20, filledQuantity: 5 }];
    connectTestAccount("SYN-PARTFILL");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-PARTFILL"), true);
    expect(result.exited).toBe(1);
    expect(broker.placed[0].quantity).toBe(85);
  });

  it("a PARTIAL native-trail placement folds its known quantity into coverage instead of blanket-skipping the fire path (the fractional remainder still gets sold)", async () => {
    // Alpaca native trailing floors to whole shares — a 10.5-share long gets a 10-share resting
    // trail, leaving a genuine 0.5-share uncovered remainder. Before the fix, ANY partial broker
    // placement this tick blanket-skipped the fire path entirely, leaving that 0.5 share naked for
    // the rest of the tick (and exposed indefinitely if the app stopped before the next one).
    broker.positions = [{ symbol: "AAPL", quantity: 10.5, averageCost: 100, marketValue: 1050 }];
    broker.quotes = { AAPL: { price: 90 } }; // extreme 100, 5% trail → trigger 95; 90 breaches
    connectTestAccount("SYN-PARTIAL-NATIVE");
    const alpacaPolicy = { ...policyFor("SYN-PARTIAL-NATIVE"), activeBroker: "alpaca" as const };
    const result = await runSyntheticStopMonitor("local", alpacaPolicy, true);
    expect(result.exited).toBe(1);
    // Two placements this tick: the broker-held native trail (floored to 10 whole shares, from
    // reconcile) and the synthetic monitor's own market sell for the uncovered 0.5-share remainder.
    expect(broker.placed).toHaveLength(2);
    const trail = broker.placed.find((o) => o.trailPercent != null);
    const marketSell = broker.placed.find((o) => o.trailPercent == null);
    expect(trail).toMatchObject({ symbol: "AAPL", quantity: 10 });
    expect(marketSell).toMatchObject({ symbol: "AAPL", side: "sell", quantity: 0.5 });
  });

  it("full-size resting exit (whatever its price) blocks the fire with an audit receipt — those shares are broker-held", async () => {
    connectTestAccount("SYN-FULLCOVER");
    upsertSyntheticStop({
      id: "stop-fullcover", userId: "local", accountNumber: "SYN-FULLCOVER", symbol: "FULLC",
      side: "long", quantity: 100, entryPrice: 100, extremePrice: 100, trailPercent: 5, status: "active"
    });
    broker.positions = [{ symbol: "FULLC", quantity: 100, averageCost: 100, marketValue: 10000 }];
    broker.quotes = { FULLC: { price: 90 } };
    // A full-size limit sell far above the market still holds all 100 shares at the broker — a
    // second sell would be rejected anyway; the stale-limit-order notifier is what flags it.
    broker.orders = [{ id: "lim-full", symbol: "FULLC", side: "sell", type: "limit", state: "new", quantity: 100 }];
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-FULLCOVER"), true);
    expect(result.triggered).toBe(1);
    expect(result.exited).toBe(0);
    expect(broker.placed).toHaveLength(0);
    expect(listSyntheticStops("SYN-FULLCOVER", "local")).toHaveLength(1); // stays armed, not claimed
    const receipts = auditPayloads("synthetic_stop_skipped_resting_exit", "FULLC");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].coveredQty).toBe(100);
    expect(receipts[0].unknownOrderQuantity).toBe(false);
  });

  it("unknowable exit-order quantity is treated as FULL coverage (no fire) with the reason on the audit receipt", async () => {
    connectTestAccount("SYN-UNKNOWNQTY");
    upsertSyntheticStop({
      id: "stop-unknownqty", userId: "local", accountNumber: "SYN-UNKNOWNQTY", symbol: "UNKQ",
      side: "long", quantity: 100, entryPrice: 100, extremePrice: 100, trailPercent: 5, status: "active"
    });
    broker.positions = [{ symbol: "UNKQ", quantity: 100, averageCost: 100, marketValue: 10000 }];
    broker.quotes = { UNKQ: { price: 90 } };
    // e.g. a notional/dollarAmount sell reports no share quantity — coverage is unknowable, so it
    // must fail toward no-duplicate-sell (skip firing), never toward a possible oversell.
    broker.orders = [{ id: "notional-1", symbol: "UNKQ", side: "sell", type: "limit", state: "new" }];
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-UNKNOWNQTY"), true);
    expect(result.exited).toBe(0);
    expect(broker.placed).toHaveLength(0);
    const receipts = auditPayloads("synthetic_stop_skipped_resting_exit", "UNKQ");
    expect(receipts).toHaveLength(1);
    expect(receipts[0].unknownOrderQuantity).toBe(true);
  });
});
