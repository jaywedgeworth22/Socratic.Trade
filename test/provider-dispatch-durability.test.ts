import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = join(tmpdir(), `socratic-provider-dispatch-${randomUUID()}`);
const path = join(dir, "test.db");
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
process.env.DATABASE_URL = `file:${path}`;

const {
  cancelUndispatchedProviderReservation,
  getDb,
  markProviderDispatchStarted,
  reconcileStaleProviderDispatches,
  reserveProviderDispatch,
  settleProviderDispatch
} = await import("../src/lib/db");

beforeEach(() => {
  getDb().exec("DELETE FROM provider_usage_outbox; DELETE FROM provider_dispatch_attempts;");
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${path}${suffix}`); } catch { /* best effort */ }
  }
});

describe("durable provider dispatch admission and usage truth", () => {
  it("atomically enforces credential-scoped windows and releases only undispatched reservations", () => {
    const now = "2026-07-14T12:00:00.000Z";
    const input = {
      provider: "fmp",
      operation: "transcript-dates",
      credentialRef: "credential-a",
      authorityId: "shared-test-authority",
      windows: [{ maxUnits: 1, windowMs: 60_000 }],
      now
    };
    const first = reserveProviderDispatch(input);
    expect(first.admitted).toBe(true);
    expect(reserveProviderDispatch(input)).toEqual({ admitted: false, reason: "request_window" });

    if (!first.admitted) throw new Error("Expected first reservation.");
    expect(cancelUndispatchedProviderReservation(first.attemptId, "test-refund", now)).toBe(true);
    const afterRefund = reserveProviderDispatch(input);
    expect(afterRefund.admitted).toBe(true);
    if (!afterRefund.admitted) throw new Error("Expected reservation after refund.");
    markProviderDispatchStarted(afterRefund.attemptId, now);
    expect(cancelUndispatchedProviderReservation(afterRefund.attemptId, "too-late", now)).toBe(false);
    expect(reserveProviderDispatch(input)).toEqual({ admitted: false, reason: "request_window" });

    expect(reserveProviderDispatch({ ...input, credentialRef: "credential-b" }).admitted).toBe(true);
  });

  it("reuses an idempotency receipt before quota evaluation without reserving twice", () => {
    const input = {
      provider: "voyage",
      operation: "embed document",
      credentialRef: "voyage-credential",
      authorityId: "shared-test-authority",
      windows: [{ maxUnits: 1, windowMs: 60_000 }],
      idempotencyKey: "logical-attempt-1",
      now: "2026-07-14T12:10:00.000Z"
    };
    const first = reserveProviderDispatch(input);
    const repeated = reserveProviderDispatch(input);
    expect(first.admitted).toBe(true);
    expect(repeated).toEqual(first);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM provider_dispatch_attempts").get())
      .toEqual({ count: 1 });
    expect(reserveProviderDispatch({ ...input, idempotencyKey: "logical-attempt-2" }))
      .toEqual({ admitted: false, reason: "request_window" });
  });

  it("persists one immutable terminal outcome and reports the reserved request units", () => {
    const reservation = reserveProviderDispatch({
      provider: "pinecone",
      operation: "upsert",
      credentialRef: "pinecone-credential",
      authorityId: "shared-test-authority",
      units: 2,
      now: "2026-07-14T12:20:00.000Z"
    });
    if (!reservation.admitted) throw new Error("Expected reservation.");
    markProviderDispatchStarted(reservation.attemptId, "2026-07-14T12:20:01.000Z");
    settleProviderDispatch(reservation.attemptId, "succeeded", {
      outcomeCode: "provider-ack",
      at: "2026-07-14T12:20:02.000Z"
    });
    // A late/double callback cannot rewrite the already-persisted truth.
    settleProviderDispatch(reservation.attemptId, "failed", {
      outcomeCode: "late-error",
      at: "2026-07-14T12:20:03.000Z"
    });

    expect(getDb().prepare(`
      SELECT status, outcome_code FROM provider_dispatch_attempts WHERE id = ?
    `).get(reservation.attemptId)).toEqual({ status: "succeeded", outcome_code: "provider-ack" });
    expect(getDb().prepare(`
      SELECT outcome, requests FROM provider_usage_outbox WHERE attempt_id = ?
    `).get(reservation.attemptId)).toEqual({ outcome: "succeeded", requests: 2 });
    expect(() => markProviderDispatchStarted(reservation.attemptId))
      .toThrow("Provider dispatch boundary was not durably recorded.");
  });

  it("turns crash-left dispatches into unknown usage and releases stale pre-dispatch rows", () => {
    const old = "2026-07-14T12:00:00.000Z";
    const dispatched = reserveProviderDispatch({
      provider: "fmp",
      operation: "transcript-body",
      credentialRef: "credential-a",
      authorityId: "shared-test-authority",
      now: old
    });
    const undispatched = reserveProviderDispatch({
      provider: "fmp",
      operation: "transcript-dates",
      credentialRef: "credential-b",
      authorityId: "shared-test-authority",
      now: old
    });
    if (!dispatched.admitted || !undispatched.admitted) throw new Error("Expected reservations.");
    markProviderDispatchStarted(dispatched.attemptId, old);

    expect(reconcileStaleProviderDispatches("2026-07-14T12:10:00.000Z", 60_000))
      .toEqual({ released: 1, unknown: 1 });
    expect(getDb().prepare(`
      SELECT status FROM provider_dispatch_attempts WHERE id = ?
    `).get(dispatched.attemptId)).toEqual({ status: "unknown" });
    expect(getDb().prepare(`
      SELECT status FROM provider_dispatch_attempts WHERE id = ?
    `).get(undispatched.attemptId)).toEqual({ status: "cancelled" });
    expect(getDb().prepare(`
      SELECT outcome FROM provider_usage_outbox WHERE attempt_id = ?
    `).get(dispatched.attemptId)).toEqual({ outcome: "unknown" });
  });

  it("charges the greater of actual and reserved cost against later daily admission", () => {
    const base = {
      provider: "voyage",
      operation: "embed",
      credentialRef: "voyage-credential",
      authorityId: "shared-test-authority",
      maxEstimatedCostUsdPer24h: 1,
      now: "2026-07-14T12:30:00.000Z"
    };
    const first = reserveProviderDispatch({ ...base, estimatedCostUsd: 0.6 });
    if (!first.admitted) throw new Error("Expected first cost reservation.");
    markProviderDispatchStarted(first.attemptId, base.now);
    settleProviderDispatch(first.attemptId, "succeeded", {
      actualCostUsd: 0.8,
      at: "2026-07-14T12:30:01.000Z"
    });
    expect(reserveProviderDispatch({ ...base, estimatedCostUsd: 0.3 }))
      .toEqual({ admitted: false, reason: "cost_cap" });
  });
});
