import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  claimProposalForExecution,
  claimSyntheticStop,
  getPolicy,
  getProposal,
  insertProposal,
  revertSyntheticStopClaim,
  setPolicy,
  updateProposalStatus,
  upsertSyntheticStop,
  listSyntheticStops
} from "../src/lib/db";
import { reconcileAutonomyOnBoot } from "../src/lib/scheduler";
import { DEFAULT_POLICY } from "../src/lib/defaults";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-deepfix-${randomUUID()}.db`)}`;
});

function seedProposed(userId = "local"): string {
  const id = randomUUID();
  insertProposal({
    id,
    userId,
    runId: "r1",
    accountNumber: "ACC1",
    proposal: { side: "buy", symbol: "AAPL" } as never,
    decision: { approved: true, reasons: [] },
    estimatedNotional: 1000,
    status: "proposed"
  });
  return id;
}

// ── Fix T4: executeProposal double-execution (atomic CAS claim) ──────────────
describe("claimProposalForExecution — atomic proposal claim", () => {
  it("only the first concurrent claim of a 'proposed' row wins; the loser sees false", () => {
    const id = seedProposed();
    expect(claimProposalForExecution(id, "placing", "local", { refId: "rid-1" })).toBe(true);
    // Second claim loses — status is no longer 'proposed'.
    expect(claimProposalForExecution(id, "placing", "local", { refId: "rid-2" })).toBe(false);
    const row = getProposal(id, "local");
    expect(row?.status).toBe("placing");
  });

  it("refuses to claim a proposal that is not 'proposed'", () => {
    const id = seedProposed();
    updateProposalStatus(id, "blocked", undefined, undefined, undefined, "local");
    expect(claimProposalForExecution(id, "placing", "local")).toBe(false);
    expect(getProposal(id, "local")?.status).toBe("blocked");
  });

  it("is scoped by userId (cannot claim another user's proposal)", () => {
    const id = seedProposed("local");
    expect(claimProposalForExecution(id, "placing", "someone-else")).toBe(false);
    expect(getProposal(id, "local")?.status).toBe("proposed");
  });
});

// ── Fix T5: synthetic-stop re-entrancy (atomic stop claim) ───────────────────
describe("claimSyntheticStop / revertSyntheticStopClaim — atomic stop claim", () => {
  function seedActiveStop(symbol: string, userId = "local"): string {
    const id = randomUUID();
    upsertSyntheticStop({
      id,
      userId,
      accountNumber: "ACC1",
      symbol,
      side: "long",
      quantity: 10,
      entryPrice: 100,
      extremePrice: 110,
      trailPercent: 5,
      trailAmount: undefined,
      status: "active",
      lastPrice: 108
    });
    return id;
  }

  it("only the first claim of an active stop wins; a concurrent monitor sees false", () => {
    const id = seedActiveStop("AAPL");
    expect(claimSyntheticStop(id, "local")).toBe(true);
    expect(claimSyntheticStop(id, "local")).toBe(false); // already 'triggered'
    // No longer listed among active stops.
    expect(listSyntheticStops("ACC1", "local").some((s) => s.id === id)).toBe(false);
  });

  it("revert re-arms a claimed stop so a failed placement can retry", () => {
    const id = seedActiveStop("MSFT");
    expect(claimSyntheticStop(id, "local")).toBe(true);
    revertSyntheticStopClaim(id, "local");
    // Back to active → claimable again on the next tick.
    expect(listSyntheticStops("ACC1", "local").some((s) => s.id === id)).toBe(true);
    expect(claimSyntheticStop(id, "local")).toBe(true);
  });
});

// ── Fix T3 (boot interlock): autonomy must not silently resume on boot ───────
describe("reconcileAutonomyOnBoot — boot-time autonomy interlock", () => {
  const userId = "local";
  afterEach(() => {
    delete process.env.AUTONOMY_RESUME_ON_BOOT;
  });

  it("reverts a persisted 'active' systemState to 'halted' when not opted in", () => {
    delete process.env.AUTONOMY_RESUME_ON_BOOT;
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "ACC1", systemState: "active" }, userId);
    reconcileAutonomyOnBoot();
    expect(getPolicy(userId).systemState).toBe("halted");
  });

  it("leaves 'active' alone when AUTONOMY_RESUME_ON_BOOT=1", () => {
    process.env.AUTONOMY_RESUME_ON_BOOT = "1";
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "ACC1", systemState: "active" }, userId);
    reconcileAutonomyOnBoot();
    expect(getPolicy(userId).systemState).toBe("active");
  });

  it("does not touch non-'active' safe states (e.g. close_only)", () => {
    delete process.env.AUTONOMY_RESUME_ON_BOOT;
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "ACC1", systemState: "close_only" }, userId);
    reconcileAutonomyOnBoot();
    expect(getPolicy(userId).systemState).toBe("close_only");
  });
});
