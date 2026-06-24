/**
 * Per-account state isolation test (PR 1).
 *
 * One user with two connected accounts must get fully independent live policy /
 * system state per account, while strategy_profiles remains the shared user-level
 * library. The active account's live state is what getPolicy(userId) returns;
 * getPolicy(userId, accountId) addresses a specific account directly.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-per-account-isolation-${randomUUID()}.db`)}`;
});

describe("per-account policy isolation (PR 1)", () => {
  const userId = `user-${randomUUID()}`;
  const a1 = `acct-1-${randomUUID()}`;
  const a2 = `acct-2-${randomUUID()}`;

  it("each connected account holds an independent live policy", async () => {
    const db = await import("../src/lib/db");

    db.upsertConnectedAccount({ id: a1, userId, broker: "alpaca", environment: "paper", accountNumber: "PA1", label: "Acct 1", isActive: true });
    db.upsertConnectedAccount({ id: a2, userId, broker: "alpaca", environment: "paper", accountNumber: "PA2", label: "Acct 2", isActive: false });

    // A1 is active: set a distinct cap, which lands on A1's live state.
    db.setPolicy({ ...db.getPolicy(userId), maxOrderNotional: 1111 }, userId);
    // Address A2 directly without switching the active account.
    db.setPolicy({ ...db.getPolicy(userId, a2), maxOrderNotional: 2222 }, userId, a2);

    expect(db.getPolicy(userId, a1).maxOrderNotional).toBe(1111);
    expect(db.getPolicy(userId, a2).maxOrderNotional).toBe(2222);
    // The user-level (active-account) view follows A1 while it is active.
    expect(db.getPolicy(userId).maxOrderNotional).toBe(1111);

    // Switching the active account flips the user-level view to A2's live state.
    db.setActiveConnectedAccount(a2, userId);
    expect(db.getPolicy(userId).maxOrderNotional).toBe(2222);
  });

  it("system state (kill-switch / run mode) is per account", async () => {
    const db = await import("../src/lib/db");

    db.setPolicy({ ...db.getPolicy(userId, a1), systemState: "active" }, userId, a1);
    db.setPolicy({ ...db.getPolicy(userId, a2), systemState: "halted" }, userId, a2);

    expect(db.getPolicy(userId, a1).systemState).toBe("active");
    expect(db.getPolicy(userId, a2).systemState).toBe("halted");
  });

  it("paperMode is derived from each account's broker", async () => {
    const db = await import("../src/lib/db");
    const testAcct = `acct-test-${randomUUID()}`;
    db.upsertConnectedAccount({ id: testAcct, userId, broker: "test", environment: "paper", label: "Sim", isActive: false });

    expect(db.getPolicy(userId, testAcct).paperMode).toBe(true);   // Test broker = local sim
    expect(db.getPolicy(userId, a1).paperMode).toBe(false);        // Alpaca paper = real broker path
  });

  it("run-lock is per account — one account's lock doesn't block another", async () => {
    const db = await import("../src/lib/db");
    const u = `lockuser-${randomUUID()}`;
    const x = `acct-x-${randomUUID()}`;
    const y = `acct-y-${randomUUID()}`;

    expect(db.acquireStrategyLock(u, x)).toBe(true);
    expect(db.acquireStrategyLock(u, x)).toBe(false); // same account re-lock blocked
    expect(db.acquireStrategyLock(u, y)).toBe(true);  // different account NOT blocked

    db.releaseStrategyLock(u, x);
    expect(db.acquireStrategyLock(u, x)).toBe(true);

    db.releaseStrategyLock(u); // no account → releases ALL of the user's locks
    expect(db.acquireStrategyLock(u, x)).toBe(true);
    expect(db.acquireStrategyLock(u, y)).toBe(true);
  });

  it("strategy runs and the cadence clock are per account", async () => {
    const db = await import("../src/lib/db");
    const u = `runuser-${randomUUID()}`;
    const x = `racct-x-${randomUUID()}`;
    const y = `racct-y-${randomUUID()}`;

    db.insertStrategyRun(randomUUID(), u, x);
    expect(db.getLastStrategyRunStartedAt(u, x)).not.toBeNull();
    expect(db.getLastStrategyRunStartedAt(u, y)).toBeNull(); // account y has no runs of its own
  });
});
