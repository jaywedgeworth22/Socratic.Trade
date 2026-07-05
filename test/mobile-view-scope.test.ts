/**
 * PR #7 — the mobile "switch account" command changes the ephemeral view pointer only; it
 * must NOT mutate any account's execution state (it is not the side-door that re-introduces
 * the view→execution coupling). Verified end-to-end through the real mobile command queue.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-mobile-view-${randomUUID()}.db`)}`;
});

describe("mobile account switch is view-only (PR #7)", () => {
  it("account.activate flips the active pointer without changing any account's run-state", async () => {
    const db = await import("../src/lib/db");
    const { queueMobileCommand, processPendingMobileCommands, listMobileCommands } = await import("../src/lib/mobile-api");

    const u = `mobile-user-${randomUUID()}`;
    const a = `a-${randomUUID()}`;
    const b = `b-${randomUUID()}`;
    db.upsertConnectedAccount({ id: a, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-A", label: "A", isActive: true });
    db.upsertConnectedAccount({ id: b, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-B", label: "B", isActive: false });

    // A armed, B halted.
    db.setPolicy({ ...db.getPolicy(u, a), systemState: "active" }, u, a);
    db.setPolicy({ ...db.getPolicy(u, b), systemState: "halted" }, u, b);

    // Mobile switches the active account to B.
    queueMobileCommand({ userId: u, commandType: "account.activate", payload: { accountId: b }, idempotencyKey: `act-${b}` });
    await processPendingMobileCommands({ limit: 5 });

    const commands = listMobileCommands({ userId: u });
    expect(commands[0]?.status).toBe("succeeded");

    // The view pointer moved to B…
    expect(db.getActiveConnectedAccount(u)?.id).toBe(b);
    // …but neither account's execution state changed.
    expect(db.getPolicy(u, a).systemState).toBe("active");
    expect(db.getPolicy(u, b).systemState).toBe("halted");
  });
});
