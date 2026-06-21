import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-consent-${randomUUID()}.db`)}`;
});

describe("data-pool consent", () => {
  it("defaults to no consent and accepts/declines per user", async () => {
    const { getDataPoolConsent, setDataPoolConsent, hasDataPoolConsent, DATA_POOL_CONSENT_VERSION } = await import("../src/lib/db");
    const userA = `u-${randomUUID()}`;
    const userB = `u-${randomUUID()}`;

    // Default: not consented.
    expect(hasDataPoolConsent(userA)).toBe(false);
    expect(getDataPoolConsent(userA).accepted).toBe(false);

    // Accept for A only — per-user isolation.
    const rec = setDataPoolConsent(userA, true);
    expect(rec.accepted).toBe(true);
    expect(rec.version).toBe(DATA_POOL_CONSENT_VERSION);
    expect(rec.acceptedAt).toBeTruthy();
    expect(hasDataPoolConsent(userA)).toBe(true);
    expect(hasDataPoolConsent(userB)).toBe(false);

    // Decline revokes.
    setDataPoolConsent(userA, false);
    expect(hasDataPoolConsent(userA)).toBe(false);
    expect(getDataPoolConsent(userA).acceptedAt).toBeNull();
  });

  it("requires the CURRENT consent version (a stale acceptance does not count)", async () => {
    const { setUserSetting, hasDataPoolConsent } = await import("../src/lib/db");
    const user = `u-${randomUUID()}`;
    // Simulate an acceptance under an older terms version.
    setUserSetting(user, "data_pool_consent", { accepted: true, acceptedAt: new Date().toISOString(), version: 0 });
    expect(hasDataPoolConsent(user)).toBe(false);
  });
});
