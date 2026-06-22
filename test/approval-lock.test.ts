/**
 * Regression tests for the TOCTOU run-lock on executeProposal.
 *
 * Bug: the daily/hourly notional cap check reads trade_proposals BEFORE
 * inserting the new row. Without mutual exclusion, a concurrent autonomous
 * run (which holds acquireStrategyLock) and a manual Approve can each read
 * the same pre-cap totals and both place — jointly exceeding the caps.
 *
 * Fix: executeProposal now acquires acquireStrategyLock(userId) before the
 * broker-review + cap-read + placement sequence, and releases it in a
 * try/finally so every return path frees the lock.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import {
  acquireStrategyLock,
  getProposal,
  insertProposal,
  releaseStrategyLock,
  setPolicy
} from "../src/lib/db";
import { executeProposal } from "../src/lib/strategy";

vi.mock("../src/lib/vector-db", () => ({
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => {}
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-approval-lock-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACCOUNT = "ACC-LOCK-TEST";

function makeProposalId(userId: string): string {
  const proposalId = randomUUID();
  insertProposal({
    id: proposalId,
    runId: randomUUID(),
    accountNumber: ACCOUNT,
    userId,
    proposal: {
      symbol: "AAPL",
      side: "buy",
      type: "market",
      dollarAmount: 500,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "lock test",
      tradeThesisTag: "Momentum-Breakout",
      entryMarketRegime: "Neutral (Normal Volatility)"
    },
    decision: { approved: true, reasons: [] },
    status: "proposed"
  });
  return proposalId;
}

function setPaperPolicy(userId: string): void {
  setPolicy(
    { ...DEFAULT_POLICY, accountNumber: ACCOUNT, systemState: "active", paperMode: true },
    userId
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeProposal run-lock (TOCTOU guard)", () => {
  it("returns { status: 'busy' } immediately when the strategy run lock is held", async () => {
    const userId = `lock-busy-${randomUUID()}`;
    setPaperPolicy(userId);
    const proposalId = makeProposalId(userId);

    // Simulate an autonomous run holding the lock.
    expect(acquireStrategyLock(userId)).toBe(true);

    try {
      const result = await executeProposal(proposalId, userId);
      expect(result.status).toBe("busy");
      expect(result.reasons).toBeDefined();
      expect(result.reasons![0]).toMatch(/strategy run is in progress/i);
    } finally {
      releaseStrategyLock(userId);
    }
  });

  it("leaves the proposal status as 'proposed' (no placement) when busy", async () => {
    const userId = `lock-noplacement-${randomUUID()}`;
    setPaperPolicy(userId);
    const proposalId = makeProposalId(userId);

    expect(acquireStrategyLock(userId)).toBe(true);
    try {
      await executeProposal(proposalId, userId);
    } finally {
      releaseStrategyLock(userId);
    }

    // The proposal must still be 'proposed' — nothing was placed or mutated.
    const row = getProposal(proposalId, userId);
    expect(row?.status).toBe("proposed");
  });

  it("releases the lock after executeProposal runs (lock is free for the next caller)", async () => {
    const userId = `lock-release-${randomUUID()}`;
    setPaperPolicy(userId);
    const proposalId = makeProposalId(userId);

    // Let executeProposal run to completion (or throw — doesn't matter).
    // The critical assertion is that the lock is released on any exit path.
    try {
      await executeProposal(proposalId, userId);
    } catch {
      // Expected: no real broker configured in tests; we only care about lock release.
    }

    // After the function exits, the lock must be free for the next caller.
    expect(acquireStrategyLock(userId)).toBe(true);
    releaseStrategyLock(userId);
  }, 20000); // executeProposal exhausts broker-review retries with no broker — allow margin over the 5s default

  it("does not interfere with a different user's lock", async () => {
    const userA = `lock-usera-${randomUUID()}`;
    const userB = `lock-userb-${randomUUID()}`;
    setPaperPolicy(userA);
    setPaperPolicy(userB);

    const proposalA = makeProposalId(userA);

    // userB holds their own lock — should NOT block userA's executeProposal.
    expect(acquireStrategyLock(userB)).toBe(true);

    let resultA: Awaited<ReturnType<typeof executeProposal>> | undefined;
    try {
      resultA = await executeProposal(proposalA, userA);
    } catch {
      // userA may throw for unrelated reasons (no broker), but must NOT return "busy".
    } finally {
      releaseStrategyLock(userB);
    }

    // If we got a result, it must not be "busy" — userB's lock does not block userA.
    if (resultA !== undefined) {
      expect(resultA.status).not.toBe("busy");
    }
  }, 20000); // executeProposal exhausts broker-review retries with no broker — allow margin over the 5s default
});
