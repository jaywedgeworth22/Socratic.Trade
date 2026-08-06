import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-consent-${randomUUID()}.db`)}`;
});

describe("data-pool consent", () => {
  it("defaults to shared pooling ON and accepts/declines per user", async () => {
    const { getDataPoolConsent, setDataPoolConsent, hasDataPoolConsent, DATA_POOL_CONSENT_VERSION } = await import("../src/lib/db");
    const userA = `u-${randomUUID()}`;
    const userB = `u-${randomUUID()}`;

    // Default (unset): share market data (owner 2026-08-05); gate may still re-prompt via version 0.
    expect(hasDataPoolConsent(userA)).toBe(true);
    expect(getDataPoolConsent(userA).accepted).toBe(true);
    expect(getDataPoolConsent(userA).version).toBe(0);

    // Explicit accept for A — current version stamp.
    const rec = setDataPoolConsent(userA, true);
    expect(rec.accepted).toBe(true);
    expect(rec.version).toBe(DATA_POOL_CONSENT_VERSION);
    expect(rec.acceptedAt).toBeTruthy();
    expect(hasDataPoolConsent(userA)).toBe(true);
    // B still unset → also pools by default (not isolated-off).
    expect(hasDataPoolConsent(userB)).toBe(true);

    // Decline revokes pooling for A only.
    setDataPoolConsent(userA, false);
    expect(hasDataPoolConsent(userA)).toBe(false);
    expect(getDataPoolConsent(userA).acceptedAt).toBeNull();
    expect(hasDataPoolConsent(userB)).toBe(true);
  });

  it("requires the CURRENT consent version (a stale acceptance does not count)", async () => {
    const { setUserSetting, hasDataPoolConsent } = await import("../src/lib/db");
    const user = `u-${randomUUID()}`;
    // Simulate an acceptance under an older terms version.
    setUserSetting(user, "data_pool_consent", { accepted: true, acceptedAt: new Date().toISOString(), version: 0 });
    expect(hasDataPoolConsent(user)).toBe(false);
  });

  // Regression (2026-07-16): GET /api/consent computed needsConsent as "not accepted",
  // so a recorded DECLINE re-opened the blocking dialog on every console load. Any
  // answer at the current version must resolve the gate; only a version bump re-asks.
  it("a recorded decline resolves the consent gate (needsConsent=false) without granting pooling", async () => {
    const { getDataPoolConsent, setDataPoolConsent, hasDataPoolConsent, DATA_POOL_CONSENT_VERSION } = await import("../src/lib/db");
    const user = `u-${randomUUID()}`;

    const needsConsent = (c: { version?: number }) => !((c.version ?? 0) >= DATA_POOL_CONSENT_VERSION);

    // Never answered → the gate must ask.
    expect(needsConsent(getDataPoolConsent(user))).toBe(true);

    // Declined → the gate must NOT ask again, and pooling stays off.
    setDataPoolConsent(user, false);
    expect(needsConsent(getDataPoolConsent(user))).toBe(false);
    expect(hasDataPoolConsent(user)).toBe(false);

    // Accepted → gate resolved, pooling on.
    setDataPoolConsent(user, true);
    expect(needsConsent(getDataPoolConsent(user))).toBe(false);
    expect(hasDataPoolConsent(user)).toBe(true);
  });
});
