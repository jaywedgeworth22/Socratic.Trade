import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Use an isolated temp SQLite database per test file
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `connection-health-routing-${randomUUID()}.db`)}`;
});

// The health route takes the Request so it can gate operator-only detail on `x-ops-token`
// (see app/api/health/route.ts). Every case below exercises the ANONYMOUS view — the liveness
// signal, degraded flags, and 200/503 status asserted here are identical in both views.
const anonymousHealthRequest = () => new Request("http://localhost/api/health");

async function load() {
  const db = await import("../src/lib/db");
  const health = await import("../src/lib/db-health");
  const notifyMod = await import("../src/lib/notify");
  const notificationsMod = await import("../src/lib/notifications");
  const healthRoute = await import("../app/api/health/route");
  return { db, health, notifyMod, notificationsMod, healthRoute };
}

describe("Connection Health & Failure Routing", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    // Stub environment variables for Resend/Notifications
    process.env.PRIMARY_USER_EMAIL = "admin@socratic.trade";
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.NOTIFY_EMAIL_FROM = "alerts@socratic.trade";
    
    // Clear out cooldown keys from DB
    const { db } = await load();
    db.getDb().prepare("DELETE FROM settings").run();
    db.getDb().prepare("DELETE FROM api_health_log").run();
    db.getDb().prepare("DELETE FROM notification_prefs").run();
    db.getDb().prepare("DELETE FROM notification_events").run();
    db.getDb().prepare("DELETE FROM audit_events").run();
  });

  afterEach(async () => {
    delete process.env.PRIMARY_USER_EMAIL;
    delete process.env.RESEND_API_KEY;
    delete process.env.NOTIFY_EMAIL_FROM;
    delete process.env.DB_BOOTSTRAP;
    delete process.env.LITESTREAM_SOCKET_PATH;
    delete process.env.LITESTREAM_STATE_PATH;
    delete process.env.RAG_EMBED_PROVIDER;
    // Remove provider keys seeded by the provider-aware rag-embed criticality tests so
    // activeEmbeddingProvider() does not leak across cases.
    try {
      const { db } = await load();
      db.deleteUserApiKey("local", "openrouter");
      db.deleteUserApiKey("local", "siliconflow");
      db.deleteUserApiKey("local", "voyage");
    } catch { /* best-effort */ }
    vi.unstubAllGlobals();
  });

  it("routes a global connection failure to admin email fallback & Sentry", async () => {
    const { health, notifyMod, notificationsMod } = await load();

    // Mock notify & sendNotification
    const notifySpy = vi.spyOn(notifyMod, "notify").mockResolvedValue([]);
    const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

    // Call global failure alert (keySource: "env")
    await health.alertConnectionFailure("pinecone", "env", "u_tenant", "API Key Invalid");

    // No delivery happens outside sendNotification's enabled-event gate. The lazy fallback callback
    // is passed alongside the normal direct bridge and invoked by sendNotification after gating.
    expect(notifySpy).not.toHaveBeenCalled();
    expect(sendNotificationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "provider_degraded",
        title: "pinecone connection failed"
      }),
      expect.objectContaining({
        userId: "local",
        directBody: expect.stringContaining("API Key Invalid"),
        additionalDelivery: expect.any(Function)
      })
    );
    const options = sendNotificationSpy.mock.calls[0]?.[1];
    await options?.additionalDelivery?.();
    expect(notifySpy).toHaveBeenCalledOnce();
    expect(notifySpy).toHaveBeenCalledWith(
      "local",
      expect.objectContaining({ title: "pinecone connection failed", body: expect.stringContaining("API Key Invalid") }),
      expect.objectContaining({ prefs: expect.objectContaining({ email: "admin@socratic.trade", channels: ["email"] }) })
    );
  });

  it("routes a user connection failure to user notifications only (no fallback email)", async () => {
    const { health, notifyMod, notificationsMod } = await load();

    const notifySpy = vi.spyOn(notifyMod, "notify").mockResolvedValue([]);
    const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

    // Call user failure alert (keySource: "user")
    await health.alertConnectionFailure("pinecone", "user", "u_tenant", "User Key Expired");

    // User delivery is also centralized inside the gate; there is no operator fallback callback.
    expect(notifySpy).not.toHaveBeenCalled();
    expect(sendNotificationSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "provider_degraded",
        title: "pinecone connection failed"
      }),
      expect.objectContaining({
        userId: "u_tenant",
        directBody: expect.stringContaining("User Key Expired")
      })
    );
    expect(sendNotificationSpy.mock.calls[0]?.[1]?.additionalDelivery).toBeUndefined();
  });

  it("does not add the operator fallback when a preferred email target already exists", async () => {
    const { db, health, notifyMod, notificationsMod } = await load();
    db.setNotifyPrefs("local", { channels: ["email"], email: "preferred@socratic.trade" });
    const notifySpy = vi.spyOn(notifyMod, "notify").mockResolvedValue([]);
    const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

    await health.alertConnectionFailure("finnhub", "env", null, "Provider unavailable");

    expect(notifySpy).not.toHaveBeenCalled();
    expect(sendNotificationSpy).toHaveBeenCalledOnce();
    expect(sendNotificationSpy.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        userId: "local",
        directBody: expect.stringContaining("Provider unavailable"),
        notifyDeps: expect.objectContaining({ config: expect.any(Object) })
      })
    );
    expect(sendNotificationSpy.mock.calls[0]?.[1]?.additionalDelivery).toBeUndefined();
  });

  it("records a storage-warning fallback delivery as sent without a duplicate", async () => {
    const { db, health } = await load();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        calls.push(String(url));
        return new Response("ok", { status: 200 });
      })
    );

    await health.alertStorageWarning("disk_space", "Persistent volume is nearly full");

    expect(calls).toEqual(["https://api.resend.com/emails"]);
    const eventAuditRow = db
      .getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'notification' ORDER BY created_at DESC LIMIT 1")
      .get() as { payload: string } | undefined;
    expect(JSON.parse(eventAuditRow?.payload ?? "{}")).toMatchObject({ title: "Storage Warning: disk space", status: "sent" });
    const delivery = db
      .getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'notification.delivery' ORDER BY created_at DESC LIMIT 1")
      .get() as { payload: string } | undefined;
    expect(JSON.parse(delivery?.payload ?? "{}")).toMatchObject({
      notificationEventId: JSON.parse(eventAuditRow?.payload ?? "{}").id,
      status: "sent",
      results: [{ channel: "email", ok: true }]
    });
  });

  it("/api/health returns 200 when dependencies are healthy", async () => {
    const { healthRoute, db } = await load();
    
    // Seed some successful health logs
    db.logApiHealth({ service: "pinecone", ok: true, keySource: "env" });
    db.logApiHealth({ service: "rag-embed", ok: true, keySource: "env" });

    // Seed lastTick so scheduler is not stale
    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());

    const response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.checks.dependencies.pinecone.ok).toBe(true);
    expect(body.checks.dependencies["rag-embed"].ok).toBe(true);
  });

  it("/api/health returns 503 when a critical global dependency fails, but stays 200 for user failures", async () => {
    const { healthRoute, db } = await load();

    // Seed lastTick
    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());

    // 1. Seed user failures (should not fail the global health check)
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "pinecone", ok: false, errorText: "Bad Key", keySource: "user", userId: "u_tenant" });
    }

    let response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(200); // Stays 200!
    let body = await response.json();
    expect(body.ok).toBe(true);

    // 2. Seed global/env failures for critical Pinecone (should fail the health check)
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "pinecone", ok: false, errorText: "Global Error", keySource: "env" });
    }

    response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(503); // Fails!
    body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.checks.dependencies.pinecone.ok).toBe(false);
  });

  // rag-embed/rag-rerank criticality (bge-m3-metering-gate 2026-07-18; lane rename 2026-07-19 —
  // see docs/rollouts/2026-07-19-advisory-cleanup-batch.md). The lanes are now provider-generic:
  // whichever embed/rerank provider is ACTUALLY active (Voyage, OpenRouter, SiliconFlow) logs
  // under "rag-embed"/"rag-rerank", so they are UNCONDITIONALLY critical — fixing the prior gap
  // where "voyage"/"voyage-rerank" only gated liveness while Voyage itself was the active provider,
  // meaning a dead OpenRouter/bge-m3 lane never failed liveness at all.
  it("/api/health 503s on a hard-stopped rag-embed/rag-rerank lane when OpenRouter is the active embed provider", async () => {
    const { healthRoute, db } = await load();

    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
    db.upsertUserApiKey("local", "openrouter", "or-test-key");

    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "rag-embed", ok: false, errorText: "OpenRouter down", keySource: "env" });
      db.logApiHealth({ service: "rag-rerank", ok: false, errorText: "OpenRouter down", keySource: "env" });
    }

    const response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(503); // now correctly critical regardless of which provider is active

    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.checks.ragEmbedProvider).toBe("openrouter");
    expect(body.checks.dependencies["rag-embed"].ok).toBe(false);
    expect(body.checks.dependencies["rag-rerank"].ok).toBe(false);
  });

  it("/api/health still 503s on a hard-stopped rag-embed lane when Voyage IS the active embed provider", async () => {
    const { healthRoute, db } = await load();

    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
    // Test-only voyage path: only when no openrouter/siliconflow key is present.
    db.upsertUserApiKey("local", "voyage", "voyage-test-key");

    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "rag-embed", ok: false, errorText: "Voyage down", keySource: "env" });
    }

    const response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.checks.ragEmbedProvider).toBe("voyage");
    expect(body.checks.dependencies["rag-embed"].ok).toBe(false);
  });

  it("/api/health does not fail liveness on a hard-stopped legacy 'voyage' lane (pre-rename/back-compat rows are no longer critical)", async () => {
    const { healthRoute, db } = await load();

    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());

    // The literal "voyage" service name is no longer written by withRagApiHealth's embed/rerank
    // call sites (see vector-db.ts), but recordMissingRagKey's missing-API-key path and historical
    // rows still use it — it must not gate liveness now that rag-embed/rag-rerank are the real lanes.
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "voyage", ok: false, errorText: "Voyage down", keySource: "env" });
    }

    const response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    // Still REPORTED (visibility unaffected), just not in criticalServices.
    expect(body.checks.dependencies.voyage.ok).toBe(false);
  });

  it("/api/health survives a pinned-but-keyless RAG_EMBED_PROVIDER (reports the config error, no 503 loop)", async () => {
    const { healthRoute, db } = await load();

    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
    process.env.RAG_EMBED_PROVIDER = "openrouter"; // pinned, but no openrouter key configured

    // Even with a hard-stopped rag-embed lane, the pin misconfiguration must not 503 the container
    // into a restart loop — it is surfaced as ragEmbedProviderError/ragConfigured:false instead.
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "rag-embed", ok: false, errorText: "Voyage down", keySource: "env" });
    }

    const response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.checks.ragConfigured).toBe(false);
    expect(String(body.checks.ragEmbedProviderError)).toMatch(/RAG_EMBED_PROVIDER/);
  });

  it("/api/health remains 200 but lists degraded status for non-critical global dependencies", async () => {
    const { healthRoute, db } = await load();

    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());

    // Seed global failures for non-critical "apify"
    for (let i = 0; i < 5; i++) {
      db.logApiHealth({ service: "apify", ok: false, errorText: "Global Error", keySource: "env" });
    }

    const response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(200); // Stays 200 because apify is not critical

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.checks.dependencies.apify.ok).toBe(false);
  });

  it("/api/health reports the live recovery path degraded when Litestream cannot be observed", async () => {
    const { healthRoute, db } = await load();

    db.setInternalSetting("scheduler:lastTick", new Date().toISOString());
    process.env.DB_BOOTSTRAP = "live";
    process.env.LITESTREAM_SOCKET_PATH = join(tmpdir(), `missing-litestream-${randomUUID()}.sock`);
    process.env.LITESTREAM_STATE_PATH = join(tmpdir(), `missing-litestream-${randomUUID()}`);

    const response = await healthRoute.GET(anonymousHealthRequest());
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.checks.storage).toMatchObject({
      litestreamState: "unknown",
      litestreamSource: "none",
      litestreamDegradedReasons: ["unavailable"]
    });
    expect(body.checks.storageDegraded).toBe(true);
  });

  // Alpha Vantage daily-cap exhaustion is a quota failure, not a transient connection blip: it
  // cannot clear before the provider's own daily reset, so re-alerting every generic 6h window is
  // pure noise for the SAME still-ongoing exhaustion (confirmed prod pattern: 1:31 AM and 8:02 AM
  // alerts for one exhausted key pool). `opts.cooldownUntil` lets the AV call site stretch the
  // suppression window to that reset instant instead of the fixed 6h; every other caller (no
  // cooldownUntil) keeps the fixed window unchanged.
  describe("alertConnectionFailure cooldown: quota-exhaustion vs generic", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("a quota-exhaustion cooldownUntil suppresses a second alert 7h later, same cap-day", async () => {
      const { health, notificationsMod } = await load();
      const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

      const start = Date.parse("2026-07-15T05:31:00Z"); // 1:31 AM ET
      vi.useFakeTimers();
      vi.setSystemTime(start);
      // Simulate the AV call site's actual reset-instant computation: ~12h away, well past a 7h check.
      const cooldownUntil = new Date(start + 12 * 60 * 60_000).toISOString();

      await health.alertConnectionFailure("alpha-vantage", "env", null, "entire key pool exhausted", { cooldownUntil });
      expect(sendNotificationSpy).toHaveBeenCalledTimes(1);

      // 7h later: past the GENERIC 6h window, but still well before this cap-day's reset.
      vi.setSystemTime(start + 7 * 60 * 60_000);
      await health.alertConnectionFailure("alpha-vantage", "env", null, "entire key pool exhausted", { cooldownUntil });
      expect(sendNotificationSpy).toHaveBeenCalledTimes(1); // still suppressed — no 8:02 AM repeat
    });

    it("a non-quota failure (no cooldownUntil) still re-alerts after the generic 6h window", async () => {
      const { health, notificationsMod } = await load();
      const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

      const start = Date.parse("2026-07-15T05:31:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(start);

      await health.alertConnectionFailure("finnhub", "env", null, "HTTP 500");
      expect(sendNotificationSpy).toHaveBeenCalledTimes(1);

      vi.setSystemTime(start + 7 * 60 * 60_000); // 7h later — past the 6h generic window
      await health.alertConnectionFailure("finnhub", "env", null, "HTTP 500");
      expect(sendNotificationSpy).toHaveBeenCalledTimes(2); // re-alerts — behavior unchanged
    });

    it("alerts again once the cap-day's cooldownUntil instant itself has passed (next reset)", async () => {
      const { health, notificationsMod } = await load();
      const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

      const start = Date.parse("2026-07-15T05:31:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(start);
      const firstReset = new Date(start + 2 * 60 * 60_000).toISOString(); // reset only 2h away

      await health.alertConnectionFailure("alpha-vantage", "env", null, "entire key pool exhausted", { cooldownUntil: firstReset });
      expect(sendNotificationSpy).toHaveBeenCalledTimes(1);

      // Still before the reset — stays suppressed.
      vi.setSystemTime(start + 60 * 60_000);
      await health.alertConnectionFailure("alpha-vantage", "env", null, "entire key pool exhausted", { cooldownUntil: firstReset });
      expect(sendNotificationSpy).toHaveBeenCalledTimes(1);

      // Past the reset instant — this is a NEW cap-day's exhaustion, so it alerts again.
      vi.setSystemTime(start + 2 * 60 * 60_000 + 1000);
      const nextReset = new Date(start + 26 * 60 * 60_000).toISOString();
      await health.alertConnectionFailure("alpha-vantage", "env", null, "entire key pool exhausted", { cooldownUntil: nextReset });
      expect(sendNotificationSpy).toHaveBeenCalledTimes(2);
    });

    it("falls back to the generic 6h window when cooldownUntil is already in the past", async () => {
      const { health, notificationsMod } = await load();
      const sendNotificationSpy = vi.spyOn(notificationsMod, "sendNotification").mockResolvedValue({} as any);

      const start = Date.parse("2026-07-15T05:31:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(start);
      const pastReset = new Date(start - 1000).toISOString(); // already elapsed — defensive/malformed input

      await health.alertConnectionFailure("alpha-vantage", "env", null, "entire key pool exhausted", { cooldownUntil: pastReset });
      expect(sendNotificationSpy).toHaveBeenCalledTimes(1);

      // 1h later — well inside the generic 6h fallback window — stays suppressed.
      vi.setSystemTime(start + 60 * 60_000);
      await health.alertConnectionFailure("alpha-vantage", "env", null, "entire key pool exhausted", { cooldownUntil: pastReset });
      expect(sendNotificationSpy).toHaveBeenCalledTimes(1);
    });
  });
});
