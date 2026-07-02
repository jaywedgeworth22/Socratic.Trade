import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-account-deletion-${randomUUID()}.db`)}`;
});

const confirmation = (email: string) => ({
  typedEmail: email,
  typedPhrase: "DELETE MY ACCOUNT",
  deleteAppData: true,
  deleteBrokerConnections: true,
  understandBrokerPositionsRemain: true,
  understandProviderRevocation: true,
  understandCanSignInAgain: true
});

describe("account deletion", () => {
  it("requires preparation and deletes only the signed-in user's private app data", async () => {
    const db = await import("../src/lib/db");
    const oauth = await import("../src/lib/mcp-oauth");
    const deletion = await import("../src/lib/account-deletion");

    const userA = `u_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const userB = `u_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const emailA = "delete-me@example.com";

    db.upsertUserApiKey(userA, "openai", "sk-user-a");
    db.upsertUserApiKey(userB, "openai", "sk-user-b");
    db.upsertConnectedAccount({
      id: `acct-${userA}`,
      userId: userA,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-DELETE",
      label: "Paper Delete",
      isActive: true
    });
    db.upsertConnectedAccount({
      id: `acct-${userB}`,
      userId: userB,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-KEEP",
      label: "Paper Keep",
      isActive: true
    });
    oauth.setMcpOAuthTokens(userA, { accessToken: "token-a", tokenType: "Bearer" });
    oauth.setMcpOAuthTokens(userB, { accessToken: "token-b", tokenType: "Bearer" });

    db.getDb()
      .prepare("INSERT INTO chat_turns (id, user_id, role, text, citations, created_at) VALUES (?, ?, 'user', ?, '[]', ?)")
      .run(randomUUID(), userA, "private question", new Date().toISOString());
    db.getDb()
      .prepare(
        `INSERT INTO learned_context (id, user_id, scope, kind, subject, value, source, origin, risk_tier, confidence, contributor_user_id, asserted_at)
         VALUES (?, ?, 'shared', 'fact', 'AAPL', 'private strategy signal', 'inferred', 'chat', 'fact', 0.7, ?, ?)`
      )
      .run(randomUUID(), userA, userA, new Date().toISOString());

    expect(() => deletion.confirmAndDeleteAccount({ userId: userA, email: emailA, body: confirmation(emailA) })).toThrow("Prepare account deletion first.");

    const prepared = deletion.prepareAccountDeletion({ userId: userA, email: emailA });
    expect(prepared.prepared).toBe(true);
    expect(prepared.connectedAccounts).toHaveLength(1);

    const result = deletion.confirmAndDeleteAccount({ userId: userA, email: emailA, body: confirmation(emailA) });
    expect(result.ok).toBe(true);

    expect(db.listConnectedAccounts(userA)).toHaveLength(0);
    expect(db.getUserApiKey(userA, "openai")).toBeUndefined();
    expect(oauth.getStoredMcpOAuthTokens(userA)).toBeUndefined();
    expect(db.getDb().prepare("SELECT COUNT(*) AS count FROM chat_turns WHERE user_id = ?").get(userA)).toMatchObject({ count: 0 });
    expect(db.getDb().prepare("SELECT COUNT(*) AS count FROM learned_context WHERE user_id = ? OR contributor_user_id = ?").get(userA, userA)).toMatchObject({ count: 0 });

    expect(db.listConnectedAccounts(userB)).toHaveLength(1);
    expect(db.getUserApiKey(userB, "openai")?.apiKey).toBe("sk-user-b");
    expect(oauth.getStoredMcpOAuthTokens(userB)?.accessToken).toBe("token-b");

    const auditRows = db.getDb().prepare("SELECT subject_hash, counts_json FROM account_deletion_audit").all() as Array<{ subject_hash: string; counts_json: string }>;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].subject_hash).not.toContain(userA);
    expect(auditRows[0].subject_hash).not.toContain(emailA);
    expect(auditRows[0].counts_json).toContain("connected_accounts");
    expect(db.getDb().prepare("SELECT COUNT(*) AS count FROM account_deletion_requests WHERE user_id = ?").get(userA)).toMatchObject({ count: 0 });
  });

  it("purges the per-user LLM budget reservation settings row (deletion sweep coverage)", async () => {
    const db = await import("../src/lib/db");
    const deletion = await import("../src/lib/account-deletion");
    const userId = `u_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const email = "reservation-delete@example.com";
    const key = `llm_budget_reservation:${userId}`;
    // Seed a leftover reservation row (as if a run crashed without releasing it).
    db.getDb()
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify({ reservations: [] }), new Date().toISOString());
    const count = () => (db.getDb().prepare("SELECT COUNT(*) AS c FROM settings WHERE key = ?").get(key) as { c: number }).c;
    expect(count()).toBe(1);

    deletion.prepareAccountDeletion({ userId, email });
    const result = deletion.confirmAndDeleteAccount({ userId, email, body: confirmation(email) });
    expect(result.ok).toBe(true);
    expect(count()).toBe(0); // the sweep deleted the reservation row
  });

  it("blocks final deletion while order placement or reconciliation is in flight", async () => {
    const db = await import("../src/lib/db");
    const deletion = await import("../src/lib/account-deletion");
    const userId = `u_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const email = "blocked-delete@example.com";

    db.getDb()
      .prepare(
        `INSERT INTO trade_proposals (id, run_id, account_number, created_at, proposal, decision, status, user_id)
         VALUES (?, ?, 'ACCT-BLOCK', ?, ?, ?, 'placing', ?)`
      )
      .run(randomUUID(), randomUUID(), new Date().toISOString(), JSON.stringify({ symbol: "AAPL", side: "buy" }), JSON.stringify({ approved: true, reasons: [] }), userId);

    deletion.prepareAccountDeletion({ userId, email });
    expect(() => deletion.confirmAndDeleteAccount({ userId, email, body: confirmation(email) })).toThrow("Account deletion is blocked by in-flight trading activity.");
  });

  it("blocks final deletion while a mobile command is in flight (queued/running)", async () => {
    const db = await import("../src/lib/db");
    const deletion = await import("../src/lib/account-deletion");
    const userId = `u_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const email = "blocked-mobile@example.com";

    // A running mobile command whose worker still holds the payload — deleting the row mid-flight
    // would let it keep mutating policy/watchlists, so it must block deletion.
    const now = new Date().toISOString();
    db.getDb()
      .prepare(
        `INSERT INTO mobile_commands (id, user_id, command_type, status, payload, created_at, queued_at, updated_at)
         VALUES (?, ?, 'run_strategy', 'running', '{}', ?, ?, ?)`
      )
      .run(randomUUID(), userId, now, now, now);

    expect(deletion.getAccountDeletionBlockers(userId).activeMobileCommands).toBe(1);

    deletion.prepareAccountDeletion({ userId, email });
    expect(() => deletion.confirmAndDeleteAccount({ userId, email, body: confirmation(email) })).toThrow("Account deletion is blocked by in-flight trading activity.");

    // A finished command (succeeded) no longer blocks — the worker is done with the payload.
    db.getDb().prepare("UPDATE mobile_commands SET status = 'succeeded' WHERE user_id = ?").run(userId);
    expect(deletion.getAccountDeletionBlockers(userId).activeMobileCommands).toBe(0);
  });
});
