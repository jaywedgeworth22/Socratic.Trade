import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  assessLitestreamRuntimeHealth,
  assessLitestreamTierFreshness,
  defaultLitestreamSocketPath,
  defaultLitestreamStatePath,
  getLitestreamRuntimeHealth,
  isLitestreamReplicatingStatus,
  LITESTREAM_TIER_LABELS,
  LITESTREAM_TIER_STALE_AFTER_SECONDS,
  parseLitestreamListPayload,
  runtimeReleaseIdentity
} from "../src/lib/runtime-health";

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";

const tempRoots: string[] = [];
const socketPaths: string[] = [];
const servers: Server[] = [];
const originalCwd = process.cwd();

function useShortSocketPath(root: string): string {
  // Darwin limits Unix-domain socket path strings to roughly 104 bytes. Vitest's
  // per-run TMPDIR is deliberately nested, so bind a short absolute name in /tmp
  // to avoid process.chdir global state issues and path length limits.
  const p = `/tmp/litestream-${randomUUID().slice(0, 8)}.sock`;
  socketPaths.push(p);
  return p;
}

async function safeListen(server: ReturnType<typeof createServer>, socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    server.once("listening", () => resolve(true));
    server.once("error", (e: any) => {
      if (e.code === "EPERM") resolve(false);
      else reject(e);
    });
    try {
      server.listen(socketPath);
    } catch (e: any) {
      if (e.code === "EPERM") resolve(false);
      else reject(e);
    }
  });
}

afterEach(async () => {
  vi.useRealTimers();
  process.chdir(originalCwd);
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const sock of socketPaths.splice(0)) {
    try { unlinkSync(sock); } catch (e) { /* ignore */ }
  }
});

describe("runtime release identity", () => {
  it("uses the first valid commit env and rejects arbitrary public strings", () => {
    const identity = runtimeReleaseIdentity({
      APP_RELEASE_SHA: "not-a-commit-or-secret",
      SOURCE_COMMIT: "ABCDEF1234567"
    }, Date.now());
    expect(identity.sha).toBe("abcdef1234567");
    expect(identity.processStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(identity.processUptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe("Litestream runtime health", () => {
  it("uses Litestream 0.5.x's hidden default metadata directory", () => {
    expect(defaultLitestreamStatePath("/app/data/app.db")).toBe("/app/data/.app.db-litestream");
  });

  it("defaults the IPC socket next to the DB (writable by non-root container users)", () => {
    expect(defaultLitestreamSocketPath("/app/data/app.db")).toBe("/app/data/litestream.sock");
    expect(defaultLitestreamSocketPath("/Users/jay/apps/trading-live/data/app.db")).toBe(
      "/Users/jay/apps/trading-live/data/litestream.sock"
    );
  });

  it("accepts both documented active-replication status spellings", () => {
    expect(isLitestreamReplicatingStatus("replicating")).toBe(true);
    expect(isLitestreamReplicatingStatus("active")).toBe(true);
    expect(isLitestreamReplicatingStatus("open")).toBe(false);
    expect(isLitestreamReplicatingStatus("stopped")).toBe(false);
  });

  it("parses the matching database and computes last-sync age", () => {
    const now = Date.parse("2026-07-11T05:00:00.000Z");
    expect(parseLitestreamListPayload({
      databases: [
        { path: "/other.db", status: "replicating", last_sync_at: "2026-07-11T04:59:59.000Z" },
        { path: "/app/data/app.db", status: "replicating", last_sync_at: "2026-07-11T04:59:30.000Z" }
      ]
    }, "/app/data/app.db", now)).toEqual({
      state: "known",
      source: "ipc",
      status: "replicating",
      lastSyncAt: "2026-07-11T04:59:30.000Z",
      ageSeconds: 30,
      timestampState: "valid"
    });
  });

  it("rejects materially future last-sync timestamps", () => {
    const now = Date.parse("2026-07-11T05:00:00.000Z");
    expect(parseLitestreamListPayload({
      databases: [{
        path: "/app/data/app.db",
        status: "replicating",
        last_sync_at: "2026-07-11T05:10:00.000Z"
      }]
    }, "/app/data/app.db", now)).toEqual({
      state: "known",
      source: "ipc",
      status: "replicating",
      lastSyncAt: null,
      ageSeconds: null,
      timestampState: "invalid"
    });
  });

  it("reads the real IPC /list shape over a Unix socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-health-"));
    tempRoots.push(root);
    const socketPath = useShortSocketPath(root);
    const server = createServer((req, res) => {
      expect(req.url).toBe("/list");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        databases: [{
          path: "/app/data/app.db",
          status: "replicating",
          last_sync_at: "2026-07-11T04:59:50.000Z"
        }]
      }));
    });
    servers.push(server);
    if (!await safeListen(server, socketPath)) return;

    await expect(getLitestreamRuntimeHealth({
      dbPath: "/app/data/app.db",
      socketPath,
      timeoutMs: 500,
      nowMs: Date.parse("2026-07-11T05:00:00.000Z")
    })).resolves.toEqual({
      state: "known",
      source: "ipc",
      status: "replicating",
      lastSyncAt: "2026-07-11T04:59:50.000Z",
      ageSeconds: 10,
      timestampState: "valid"
    });
  });

  it("finds the control socket at the Litestream 0.5.x db-dir default when no path is configured", async () => {
    // Prod 2026-07-30..08-01: 0.5.12 ignores the config file's `socket.path` and listens at
    // <db-dir>/litestream.sock; the health probe only tried /var/run/litestream.sock and
    // reported litestreamState "unknown" for days while replication was healthy. The probe
    // must now discover the db-dir default on its own (no explicit socketPath, no env).
    vi.stubEnv("LITESTREAM_SOCKET_PATH", "");
    const root = mkdtempSync("/tmp/litestream-dbdir-");
    tempRoots.push(root);
    const dbPath = join(root, "app.db");
    const socketPath = join(root, "litestream.sock");
    socketPaths.push(socketPath);
    const server = createServer((req, res) => {
      expect(req.url).toBe("/list");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        databases: [{
          path: dbPath,
          status: "replicating",
          last_sync_at: "2026-07-11T04:59:50.000Z"
        }]
      }));
    });
    servers.push(server);
    if (!await safeListen(server, socketPath)) return;

    await expect(getLitestreamRuntimeHealth({
      dbPath,
      timeoutMs: 500,
      allowFileFallback: false,
      nowMs: Date.parse("2026-07-11T05:00:00.000Z")
    })).resolves.toEqual({
      state: "known",
      source: "ipc",
      status: "replicating",
      lastSyncAt: "2026-07-11T04:59:50.000Z",
      ageSeconds: 10,
      timestampState: "valid"
    });
  });

  it("enforces a wall-clock deadline even when the socket keeps trickling bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-deadline-"));
    tempRoots.push(root);
    const socketPath = useShortSocketPath(root);
    const server = createServer((_req, res) => {
      res.write("{");
      const interval = setInterval(() => res.write(" "), 5);
      res.on("close", () => clearInterval(interval));
    });
    servers.push(server);
    if (!await safeListen(server, socketPath)) return;

    let watchdog: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      getLitestreamRuntimeHealth({
        dbPath: "/app/data/app.db",
        socketPath,
        timeoutMs: 30
      }),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error("IPC wall-clock deadline did not fire")), 300);
      })
    ]).finally(() => {
      if (watchdog) clearTimeout(watchdog);
    });
    expect(result).toEqual({ state: "unknown", source: "none" });
  });

  it("caps IPC response bodies and falls back instead of buffering without limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-cap-"));
    tempRoots.push(root);
    const socketPath = useShortSocketPath(root);
    const statePath = join(root, "last-activity");
    writeFileSync(statePath, "ok");
    const server = createServer((_req, res) => {
      res.end(JSON.stringify({
        databases: [{
          path: "/app/data/app.db",
          status: "replicating",
          last_sync_at: "2026-07-11T04:59:50.000Z",
          padding: "x".repeat(512)
        }]
      }));
    });
    servers.push(server);
    if (!await safeListen(server, socketPath)) return;

    const result = await getLitestreamRuntimeHealth({
      dbPath: "/app/data/app.db",
      socketPath,
      statePath,
      maxResponseBytes: 128,
      timeoutMs: 500
    });
    expect(result).toMatchObject({ state: "known", source: "file", status: "activity-observed" });
  });

  it("falls back promptly when the daemon aborts a partial response", async () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-abort-"));
    tempRoots.push(root);
    const socketPath = useShortSocketPath(root);
    const server = createServer((_req, res) => {
      res.write('{"databases":[');
      res.socket?.destroy();
    });
    servers.push(server);
    if (!await safeListen(server, socketPath)) return;

    let watchdog: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      getLitestreamRuntimeHealth({
        dbPath: "/app/data/app.db",
        socketPath,
        timeoutMs: 1_000
      }),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error("aborted IPC response was not handled")), 300);
      })
    ]).finally(() => {
      if (watchdog) clearTimeout(watchdog);
    });
    expect(result).toEqual({ state: "unknown", source: "none" });
  });

  it("falls back to an explicitly tracked state file when IPC is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T05:00:00.000Z"));
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-state-"));
    tempRoots.push(root);
    const statePath = join(root, "last-sync");
    writeFileSync(statePath, "ok");
    const now = new Date("2026-07-11T05:00:00.000Z");
    utimesSync(statePath, now, now);

    const result = await getLitestreamRuntimeHealth({
      dbPath: "/app/data/app.db",
      socketPath: join(root, "missing.sock"),
      statePath,
      timeoutMs: 25,
      nowMs: Date.now()
    });
    expect(result).toMatchObject({ state: "known", source: "file", status: "activity-observed" });
    expect(result.state === "known" ? result.ageSeconds : null).toBe(0);
  });

  it("skips file metadata entirely when live mode disables the diagnostic fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-live-skip-"));
    tempRoots.push(root);
    const statePath = join(root, "last-activity");
    writeFileSync(statePath, "recent but not proof of an R2 upload");

    await expect(getLitestreamRuntimeHealth({
      dbPath: "/app/data/app.db",
      socketPath: join(root, "missing.sock"),
      statePath,
      allowFileFallback: false,
      timeoutMs: 25
    })).resolves.toEqual({ state: "unknown", source: "none" });
  });

  it("bounds non-live metadata scans instead of traversing arbitrarily large trees", async () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-bounded-scan-"));
    tempRoots.push(root);
    for (let index = 0; index < 300; index += 1) {
      writeFileSync(join(root, `entry-${index}`), "x");
    }

    await expect(getLitestreamRuntimeHealth({
      dbPath: "/app/data/app.db",
      socketPath: join(root, "missing.sock"),
      statePath: root,
      timeoutMs: 25
    })).resolves.toEqual({ state: "unknown", source: "none" });
  });

  it("reports unknown without treating an absent daemon as healthy", async () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-missing-"));
    tempRoots.push(root);
    await expect(getLitestreamRuntimeHealth({
      dbPath: "/app/data/app.db",
      socketPath: join(root, "missing.sock"),
      timeoutMs: 25
    })).resolves.toEqual({ state: "unknown", source: "none" });
  });
});

describe("Litestream production health decisions", () => {
  const healthy = {
    state: "known" as const,
    source: "ipc" as const,
    status: "replicating",
    lastSyncAt: "2026-07-11T04:59:50.000Z",
    ageSeconds: 10,
    timestampState: "valid" as const
  };

  it("accepts a recent successful IPC sync in live mode", () => {
    expect(assessLitestreamRuntimeHealth(healthy, {
      liveMode: true,
      processUptimeSeconds: 600
    })).toEqual({ degraded: false, reasons: [] });
  });

  it("marks an unavailable live-mode signal degraded", () => {
    expect(assessLitestreamRuntimeHealth({ state: "unknown", source: "none" }, {
      liveMode: true,
      processUptimeSeconds: 10
    })).toEqual({ degraded: true, reasons: ["unavailable"] });
  });

  it("never treats a fresh file mtime as verified R2 health in live mode", () => {
    expect(assessLitestreamRuntimeHealth({
      state: "known",
      source: "file",
      status: "activity-observed",
      lastSyncAt: "2026-07-11T05:00:00.000Z",
      ageSeconds: 0,
      timestampState: "valid"
    }, {
      liveMode: true,
      processUptimeSeconds: 600
    })).toEqual({ degraded: true, reasons: ["file-unverified"] });
  });

  it("allows a missing first sync only during startup grace", () => {
    const neverSynced = { ...healthy, lastSyncAt: null, ageSeconds: null, timestampState: "missing" as const };
    expect(assessLitestreamRuntimeHealth(neverSynced, {
      liveMode: true,
      processUptimeSeconds: 299,
      startupGraceSeconds: 300
    })).toEqual({ degraded: false, reasons: [] });
    expect(assessLitestreamRuntimeHealth(neverSynced, {
      liveMode: true,
      processUptimeSeconds: 300,
      startupGraceSeconds: 300
    })).toEqual({ degraded: true, reasons: ["never-synced"] });
  });

  it("marks unsynced local activity stale but keeps an idle caught-up database healthy", () => {
    expect(assessLitestreamRuntimeHealth({ ...healthy, ageSeconds: 3_601 }, {
      liveMode: true,
      processUptimeSeconds: 600,
      staleAfterSeconds: 3_600,
      latestLocalActivityAtMs: Date.parse("2026-07-11T05:00:00.000Z")
    })).toEqual({ degraded: true, reasons: ["stale"] });
    expect(assessLitestreamRuntimeHealth({ ...healthy, ageSeconds: 3_601 }, {
      liveMode: true,
      processUptimeSeconds: 600,
      staleAfterSeconds: 3_600,
      latestLocalActivityAtMs: Date.parse("2026-07-11T04:00:00.000Z")
    })).toEqual({ degraded: false, reasons: [] });
  });

  it("marks stopped and invalid-timestamp IPC states degraded", () => {
    expect(assessLitestreamRuntimeHealth({ ...healthy, status: "stopped" }, {
      liveMode: true,
      processUptimeSeconds: 600
    })).toEqual({ degraded: true, reasons: ["stopped"] });
    expect(assessLitestreamRuntimeHealth({
      ...healthy,
      lastSyncAt: null,
      ageSeconds: null,
      timestampState: "invalid"
    }, {
      liveMode: true,
      processUptimeSeconds: 600
    })).toEqual({ degraded: true, reasons: ["invalid-sync-time"] });
  });

  it("keeps a file signal diagnostic-only without degrading non-live development", () => {
    expect(assessLitestreamRuntimeHealth({
      state: "known",
      source: "file",
      status: "activity-observed",
      lastSyncAt: "2026-07-11T05:00:00.000Z",
      ageSeconds: 0,
      timestampState: "valid"
    }, {
      liveMode: false,
      processUptimeSeconds: 600
    })).toEqual({ degraded: false, reasons: [] });
  });
});

describe("Litestream per-tier compaction freshness", () => {
  function writeTierFile(statePath: string, tier: "0" | "1" | "9", mtime: Date) {
    const dir = join(statePath, "ltx", tier);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${tier}-000000000000001-000000000000002.ltx`);
    writeFileSync(file, "ltx");
    utimesSync(file, mtime, mtime);
  }

  it("reports every tier unknown (never crashing) when the state directory does not exist at all", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-tiers-missing-"));
    tempRoots.push(root);
    const statePath = join(root, "does-not-exist");

    const report = assessLitestreamTierFreshness(statePath, { nowMs: Date.now() });
    expect(report.degraded).toBe(false);
    expect(report.tiers).toHaveLength(5);
    for (const tier of report.tiers) {
      expect(tier.state).toBe("unknown");
      expect(tier).not.toHaveProperty("ageSeconds");
      expect(tier).not.toHaveProperty("newestActivityAt");
    }
    // Labels are always present, even for an unknown tier, so the UI has something to render.
    expect(report.tiers.map((t) => t.label)).toEqual([
      LITESTREAM_TIER_LABELS["0"],
      LITESTREAM_TIER_LABELS["1"],
      LITESTREAM_TIER_LABELS["2"],
      LITESTREAM_TIER_LABELS["3"],
      LITESTREAM_TIER_LABELS["9"]
    ]);
  });

  it("reports unknown (not a crash, not degraded) when no statePath is configured at all", () => {
    const report = assessLitestreamTierFreshness(undefined);
    expect(report.degraded).toBe(false);
    expect(report.tiers.every((t) => t.state === "unknown")).toBe(true);
  });

  it("reports unknown for a tier directory that exists but has never received a file", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-tiers-empty-"));
    tempRoots.push(root);
    mkdirSync(join(root, "ltx", "1"), { recursive: true });

    const report = assessLitestreamTierFreshness(root, { nowMs: Date.now() });
    const tier1 = report.tiers.find((t) => t.tier === "1")!;
    expect(tier1.state).toBe("unknown");
    expect(report.degraded).toBe(false);
  });

  it("marks a tier healthy when its newest file is within threshold, and degraded when it is not", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-tiers-fresh-stale-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-11T12:00:00.000Z");

    writeTierFile(root, "0", new Date(now - 30_000)); // 30s old — within the 10-minute threshold
    writeTierFile(root, "1", new Date(now - 30_000)); // also fresh — within the 4-hour threshold

    const report = assessLitestreamTierFreshness(root, { nowMs: now });
    const [t0, t1, t9] = report.tiers;
    expect(t0).toMatchObject({ tier: "0", state: "known", ageSeconds: 30, degraded: false });
    expect(t1).toMatchObject({ tier: "1", state: "known", ageSeconds: 30, degraded: false });
    expect(t9.state).toBe("unknown"); // no level-9 file written yet in this fixture
    expect(report.degraded).toBe(false);
  });

  // This is the production incident this function exists to catch: level 0 (continuous sync)
  // keeps succeeding on schedule while level 1 (periodic compaction) is silently wedged for
  // hours. The existing IPC-based overall signal only reflects level 0 and would report this
  // database perfectly healthy the whole time — only the per-tier breakdown catches it.
  it("flags a stuck level-1 compactor even while level 0 stays fresh (the 2026-08-11 incident shape)", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-tiers-incident-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-11T12:00:00.000Z");

    writeTierFile(root, "0", new Date(now - 45_000)); // level 0: 45s old, healthy
    writeTierFile(root, "1", new Date(now - 27 * 3_600_000)); // level 1: 27h old, wedged
    writeTierFile(root, "9", new Date(now - 10 * 3_600_000)); // level 9: 10h old, within 30h

    const report = assessLitestreamTierFreshness(root, { nowMs: now });
    const byTier = Object.fromEntries(report.tiers.map((t) => [t.tier, t]));

    expect(byTier["0"]).toMatchObject({ state: "known", degraded: false });
    expect(byTier["1"]).toMatchObject({ state: "known", degraded: true, ageSeconds: 27 * 3_600 });
    expect(byTier["9"]).toMatchObject({ state: "known", degraded: false });
    // The overall report-level flag is true because at least one KNOWN tier is degraded —
    // this is what app/api/health/route.ts folds into storageDegraded.
    expect(report.degraded).toBe(true);
  });

  it("uses the documented default thresholds and accepts a caller-supplied override per tier", () => {
    expect(LITESTREAM_TIER_STALE_AFTER_SECONDS).toEqual({
      "0": 10 * 60,
      "1": 4 * 60 * 60,
      "2": 2 * 60 * 60,
      "3": 6 * 60 * 60,
      "9": 30 * 60 * 60
    });

    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-tiers-override-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    writeTierFile(root, "0", new Date(now - 5 * 60_000)); // 5 minutes old

    // Below the default 10-minute threshold: healthy.
    expect(assessLitestreamTierFreshness(root, { nowMs: now }).tiers[0]).toMatchObject({ degraded: false });
    // A tighter caller-supplied threshold (1 minute) flips the same data to degraded, proving
    // the threshold is actually load-bearing and not hardcoded past the options parameter.
    expect(
      assessLitestreamTierFreshness(root, { nowMs: now, thresholdsSeconds: { "0": 60 } }).tiers[0]
    ).toMatchObject({ degraded: true, thresholdSeconds: 60 });
  });

  it("does not throw when the scan hits the same bounded-entries limit newestFileMtimeMs enforces elsewhere", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-tiers-bounded-"));
    tempRoots.push(root);
    const dir = join(root, "ltx", "0");
    mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 300; index += 1) {
      writeFileSync(join(dir, `entry-${index}.ltx`), "x");
    }

    const report = assessLitestreamTierFreshness(root, { nowMs: Date.now() });
    expect(report.tiers.find((t) => t.tier === "0")!.state).toBe("unknown");
    expect(report.degraded).toBe(false);
  });
});
