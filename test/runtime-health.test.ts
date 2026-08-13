import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  assessLitestreamRuntimeHealth,
  assessLitestreamTierFreshness,
  compareLitestreamTxid,
  defaultLitestreamRuntimeLogPath,
  defaultLitestreamSocketPath,
  defaultLitestreamStatePath,
  getLitestreamRuntimeHealth,
  isLitestreamReplicatingStatus,
  LITESTREAM_TIER_LABELS,
  LITESTREAM_TIER_STALE_AFTER_SECONDS,
  maxTxidFromLtxFilename,
  parseLitestreamListPayload,
  runtimeReleaseIdentity,
  scanLitestreamRuntimeLogFile,
  scanLitestreamRuntimeLogText
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

  // This test used to assert the OPPOSITE: that a directory over 256 entries made the scan
  // return `{ state: "unknown" }`. Bounding the work was right; answering "I saw nothing"
  // because the directory was big was not — that is defect cause #2 from the 2026-08-12
  // rollout, and it blinded the per-tier check on every production health probe, since
  // `ltx/0` normally holds 1,000+ files. The scan is still bounded (a fixed stat budget per
  // directory, plus depth and directory-count caps); it just no longer refuses to answer.
  it("stays bounded on a large metadata tree while still reporting the newest activity", async () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-litestream-bounded-scan-"));
    tempRoots.push(root);
    const now = Date.now();
    const ltxDir = join(root, "ltx", "0");
    mkdirSync(ltxDir, { recursive: true });
    for (let index = 0; index < 1200; index += 1) {
      const hex = (0x37000 + index).toString(16).padStart(16, "0");
      const file = join(ltxDir, `${hex}-${hex}.ltx`);
      writeFileSync(file, "x");
      const mtime = new Date(now - (1200 - index) * 60_000);
      utimesSync(file, mtime, mtime);
    }

    const started = Date.now();
    const result = await getLitestreamRuntimeHealth({
      dbPath: "/app/data/app.db",
      socketPath: join(root, "missing.sock"),
      statePath: root,
      timeoutMs: 25
    });

    expect(result).toMatchObject({ state: "known", source: "file", status: "activity-observed" });
    // The newest of the 1,200 files, found without stat-ing all of them.
    expect(result.state === "known" && result.ageSeconds).toBeLessThanOrEqual(120);
    // Bounded work, not a full 1,200-entry stat sweep.
    expect(Date.now() - started).toBeLessThan(2_000);
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


// ---------------------------------------------------------------------------------------
// Per-compaction-level backup freshness.
//
// The 2026-08-11/12 implementation of this feature had ZERO production coverage: it graded
// every level from local `ltx/<level>/` mtimes, but (1) Litestream 0.5.12 keeps only level 0
// on local disk, so levels 1/2/3/9 had no directory to read, and (2) the shared scan bailed
// out to `null` past 256 entries while `ltx/0` legitimately holds 1,000+ files. Every tier
// reported "unknown" on every health check while appearing to cover all five.
//
// These tests pin down the replacement: a real signal per level where one exists, an explicit
// and explained "not-observable" where one does not, and detection of the actual wedge.
// ---------------------------------------------------------------------------------------
describe("Litestream per-tier compaction freshness", () => {
  function writeLtxFile(statePath: string, tier: string, name: string, mtime: Date) {
    const dir = join(statePath, "ltx", tier);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, "ltx");
    utimesSync(file, mtime, mtime);
  }

  /** Litestream's real filename shape: `<minTXID>-<maxTXID>.ltx`, zero-padded hex. */
  function ltxName(txid: number): string {
    const hex = txid.toString(16).padStart(16, "0");
    return `${hex}-${hex}.ltx`;
  }

  function remoteLevel(level: number, newestAt: string, newestTxid: string | null, fileCount = 1) {
    return { level, newestAt, newestTxid, fileCount };
  }

  function byTier(report: { tiers: Array<{ tier: string }> }) {
    return Object.fromEntries(report.tiers.map((t) => [t.tier, t])) as Record<string, any>;
  }

  it("parses Litestream's LTX filename txid range and orders ids of differing widths numerically", () => {
    expect(maxTxidFromLtxFilename("0000000000005249-00000000000052a8.ltx")).toBe("00000000000052a8");
    expect(maxTxidFromLtxFilename("not-an-ltx-file.txt")).toBeNull();
    // 0x37ce0 (level 0, live) is far ahead of 0xe5ad (level 2, wedged) despite equal padding.
    expect(compareLitestreamTxid("0000000000037ce0", "000000000000e5ad")).toBeGreaterThan(0);
    // Differing widths must still compare numerically, not lexicographically.
    expect(compareLitestreamTxid("ff", "0000000000000100")).toBeLessThan(0);
    expect(compareLitestreamTxid("00000000000052a8", "52a8")).toBe(0);
  });

  // REGRESSION for defect cause #2. `ltx/0` held 1,078 files on the live container on
  // 2026-08-12; the old flat 256-entry bound made the scan return null, so the ONE level that
  // is genuinely readable locally still reported "unknown" on every single health check. The
  // replacement stats only the highest-named few entries, so directory size is irrelevant.
  it("measures level 0 from a directory holding far more files than the old 256-entry bound", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-large-l0-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-12T23:30:00.000Z");

    // 1,200 files, mirroring production scale. Older txids get older mtimes, so the newest
    // filename is also the newest write — the property the sampling strategy relies on.
    for (let index = 0; index < 1200; index += 1) {
      writeLtxFile(root, "0", ltxName(0x37000 + index), new Date(now - (1200 - index) * 60_000));
    }

    const report = assessLitestreamTierFreshness(root, { nowMs: now });
    const tier0 = byTier(report)["0"];
    expect(tier0.state).toBe("known");
    expect(tier0.source).toBe("local-ltx");
    expect(tier0.ageSeconds).toBe(60); // the newest of the 1,200 files, not a bailout
    expect(tier0.newestTxid).toBe((0x37000 + 1199).toString(16).padStart(16, "0"));
    expect(tier0.degraded).toBe(false);
  });

  // REGRESSION for defect cause #1. Levels 1/2/3/9 have no local directory in production, and
  // the old code called that "unknown" — indistinguishable from "we looked and all is quiet".
  it("reports levels that exist only in the remote replica as not-observable, with a reason, when no inventory has been collected", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-remote-only-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-12T23:30:00.000Z");
    writeLtxFile(root, "0", ltxName(0x37ce0), new Date(now - 60_000));

    const report = assessLitestreamTierFreshness(root, { nowMs: now, remoteInventory: null });
    const tiers = byTier(report);

    expect(tiers["0"].state).toBe("known");
    for (const tier of ["1", "2", "3", "9"]) {
      expect(tiers[tier].state).toBe("not-observable");
      expect(tiers[tier].reason).toBe("remote-inventory-missing");
      expect(tiers[tier].detail).toContain("remote replica");
      // Crucially NOT a verdict: no age, no degraded flag to misread as health.
      expect(tiers[tier]).not.toHaveProperty("ageSeconds");
      expect(tiers[tier]).not.toHaveProperty("degraded");
    }
    // The report says out loud how much it actually covers.
    expect(report.observedTiers).toBe(1);
    expect(report.notObservableTiers).toBe(4);
    expect(report.remoteInventoryState).toBe("missing");
    // "Cannot see it" must never be reported as "it is broken".
    expect(report.degraded).toBe(false);
  });

  it("reports every tier not-observable, never crashing, when no state path is configured at all", () => {
    const report = assessLitestreamTierFreshness(undefined);
    expect(report.tiers).toHaveLength(5);
    expect(report.tiers.every((t) => t.state === "not-observable")).toBe(true);
    expect(report.tiers.every((t) => "reason" in t && t.reason === "no-state-path")).toBe(true);
    expect(report.observedTiers).toBe(0);
    expect(report.degraded).toBe(false);
    // Labels stay present so the UI always has all five cards to render.
    expect(report.tiers.map((t) => t.label)).toEqual([
      LITESTREAM_TIER_LABELS["0"],
      LITESTREAM_TIER_LABELS["1"],
      LITESTREAM_TIER_LABELS["2"],
      LITESTREAM_TIER_LABELS["3"],
      LITESTREAM_TIER_LABELS["9"]
    ]);
  });

  // ===================================================================================
  // THE INCIDENT. Every number below was read off the live production replica at
  // 2026-08-12T23:30Z, while `/api/health` reported all five tiers "unknown" and the
  // container log was emitting `compaction failed ... level=2 ... non-contiguous
  // transaction ids` roughly every 30 minutes.
  // ===================================================================================
  it("flags the wedged level-2 compaction from the real 2026-08-12 production replica state", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-incident-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-12T23:30:00.000Z");

    // Level 0 is healthy and ADVANCING — this is what made the wedge invisible to every
    // pre-existing signal, all of which track level 0's last sync.
    writeLtxFile(root, "0", ltxName(0x37cde), new Date(now - 252_000));
    writeLtxFile(root, "0", ltxName(0x37ce0), new Date(now - 238_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      remoteInventory: {
        collectedAt: "2026-08-12T23:20:00.000Z",
        status: "ok",
        levels: {
          "1": remoteLevel(1, "2026-08-10T14:54:39.000Z", "000000000002324c", 5635),
          "2": remoteLevel(2, "2026-08-08T14:35:05.000Z", "000000000000e5ad", 171),
          "3": remoteLevel(3, "2026-08-08T15:00:22.000Z", "000000000000e5ad", 15),
          "9": remoteLevel(9, "2026-08-12T00:01:18.000Z", "0000000000030586", 8)
        },
        levelErrors: {},
        skippedReason: null
      }
    });
    const tiers = byTier(report);

    // Level 0: fresh, and the reason the higher levels are provably behind rather than idle.
    expect(tiers["0"]).toMatchObject({ state: "known", source: "local-ltx", degraded: false });

    // Level 2: THE WEDGE. Frozen since 2026-08-08 at txid 0xe5ad while level 0 reached
    // 0x37ce0. This is the failure the whole monitor exists to catch and previously could not.
    expect(tiers["2"]).toMatchObject({
      state: "known",
      source: "remote-inventory",
      newestTxid: "000000000000e5ad",
      degraded: true
    });
    expect(tiers["2"].ageSeconds).toBeGreaterThan(4 * 24 * 3600);

    // Levels 1 and 3 were also stalled behind level 0 at the same moment.
    expect(tiers["1"]).toMatchObject({ state: "known", degraded: true });
    expect(tiers["3"]).toMatchObject({ state: "known", degraded: true });

    // Level 9 (daily snapshot) was genuinely healthy ~23.5h old, inside its 30h threshold —
    // proving the check discriminates rather than blanket-failing everything remote.
    expect(tiers["9"]).toMatchObject({ state: "known", degraded: false });
    expect(tiers["9"].ageSeconds).toBeLessThan(30 * 3600);

    expect(report.degraded).toBe(true);
    expect(report.observedTiers).toBe(5);
    expect(report.notObservableTiers).toBe(0);
  });

  // The counterpart guard: without it, every quiet period on an idle database would light up
  // all four higher levels. A level that has caught up with level 0 has nothing left to do.
  it("does not flag a quiet higher level that has already caught up with level 0", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-idle-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-12T23:30:00.000Z");

    // Database idle for 3 days: level 0's newest file is old, and level 2 compacted right up
    // to it before everything went quiet.
    writeLtxFile(root, "0", ltxName(0xe5ad), new Date(now - 3 * 24 * 3_600_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      remoteInventory: {
        collectedAt: "2026-08-12T23:20:00.000Z",
        status: "ok",
        levels: {
          "1": remoteLevel(1, "2026-08-09T23:30:00.000Z", "000000000000e5ad"),
          "2": remoteLevel(2, "2026-08-09T23:30:00.000Z", "000000000000e5ad"),
          "3": remoteLevel(3, "2026-08-09T23:30:00.000Z", "000000000000e5ad"),
          "9": remoteLevel(9, "2026-08-09T23:30:00.000Z", "000000000000e5ad")
        },
        levelErrors: {},
        skippedReason: null
      }
    });
    const tiers = byTier(report);

    for (const tier of ["1", "2", "3", "9"]) {
      expect(tiers[tier].state).toBe("known");
      expect(tiers[tier].ageSeconds).toBeGreaterThan(tiers[tier].thresholdSeconds);
      expect(tiers[tier].degraded).toBe(false); // caught up with level 0 — nothing to compact
    }
    // Level 0 itself IS graded on age alone, and 3 days idle is past its 10-minute threshold.
    expect(tiers["0"].degraded).toBe(true);
  });

  it("refuses to grade remote levels from an inventory older than the max age, and says why", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-stale-inv-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-12T23:30:00.000Z");
    writeLtxFile(root, "0", ltxName(0x37ce0), new Date(now - 60_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      // Collected 4 hours ago — well past LITESTREAM_REMOTE_INVENTORY_MAX_AGE_SECONDS (90 min).
      remoteInventory: {
        collectedAt: new Date(now - 4 * 3_600_000).toISOString(),
        status: "ok",
        levels: { "2": remoteLevel(2, "2026-08-08T14:35:05.000Z", "000000000000e5ad", 171) },
        levelErrors: {},
        skippedReason: null
      }
    });
    const tiers = byTier(report);

    // A dead collector must not be reported as a wedged backup: frozen numbers would age out
    // on their own and manufacture an incident that is not happening.
    expect(tiers["2"]).toMatchObject({ state: "not-observable", reason: "remote-inventory-stale" });
    expect(report.remoteInventoryState).toBe("stale");
    expect(report.degraded).toBe(false);
  });

  it("distinguishes a failed level listing, an un-collected level, and a level with no files at all", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-mixed-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-12T23:30:00.000Z");
    writeLtxFile(root, "0", ltxName(0x37ce0), new Date(now - 60_000));

    const report = assessLitestreamTierFreshness(root, {
      nowMs: now,
      remoteInventory: {
        collectedAt: "2026-08-12T23:20:00.000Z",
        status: "partial",
        levels: {
          "2": remoteLevel(2, "2026-08-12T23:00:00.000Z", "000000000002324c", 171),
          "3": remoteLevel(3, "", null, 0) // listed fine; the level has simply never produced
        },
        levelErrors: { "1": "dial tcp: connection refused" },
        skippedReason: null
      }
    });
    const tiers = byTier(report);

    expect(tiers["1"]).toMatchObject({ state: "not-observable", reason: "remote-inventory-failed" });
    expect(tiers["1"].detail).toContain("connection refused");
    expect(tiers["2"].state).toBe("known");
    expect(tiers["3"]).toMatchObject({ state: "not-observable", reason: "no-activity-recorded" });
    expect(tiers["9"]).toMatchObject({ state: "not-observable", reason: "remote-inventory-missing" });
    expect(report.observedTiers).toBe(2);
    expect(report.notObservableTiers).toBe(3);
  });

  it("uses the documented default thresholds and accepts a caller-supplied override per tier", () => {
    expect(LITESTREAM_TIER_STALE_AFTER_SECONDS).toEqual({
      "0": 10 * 60,
      "1": 4 * 60 * 60,
      "2": 2 * 60 * 60,
      "3": 6 * 60 * 60,
      "9": 30 * 60 * 60
    });

    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-override-"));
    tempRoots.push(root);
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    writeLtxFile(root, "0", ltxName(0x1000), new Date(now - 5 * 60_000)); // 5 minutes old

    // Below the default 10-minute threshold: healthy.
    expect(assessLitestreamTierFreshness(root, { nowMs: now }).tiers[0]).toMatchObject({ degraded: false });
    // A tighter caller-supplied threshold (1 minute) flips the same data to degraded, proving
    // the threshold is actually load-bearing and not hardcoded past the options parameter.
    expect(
      assessLitestreamTierFreshness(root, { nowMs: now, thresholdsSeconds: { "0": 60 } }).tiers[0]
    ).toMatchObject({ degraded: true, thresholdSeconds: 60 });
  });

  it("ignores non-LTX files and an empty local level directory without inventing activity", () => {
    const root = mkdtempSync(join(tmpdir(), "socratic-ltx-noise-"));
    tempRoots.push(root);
    mkdirSync(join(root, "ltx", "0"), { recursive: true });
    writeFileSync(join(root, "ltx", "0", "README.txt"), "not an ltx file");

    const report = assessLitestreamTierFreshness(root, { nowMs: Date.now() });
    expect(byTier(report)["0"]).toMatchObject({ state: "not-observable" });
    expect(report.degraded).toBe(false);
  });
});

// Third, independent signal (2026-08-13): litestream's own log lines, teed by
// scripts/coolify-prod-start.sh into a local file (litestream wraps the app via `-exec` and owns
// the container's real stdout, so a shared file is the only way the app can ever read what
// litestream itself reported). This needs no S3/B2 credentials and does not depend on the remote
// LTX inventory that assessLitestreamTierFreshness above relies on for levels 1/2/3/9 — a
// deliberately independent check so a wedge is still visible even while that other pipeline is
// broken (see the known litestream-remote-inventory scheduler bug referenced in
// app/api/health/route.ts).
describe("defaultLitestreamRuntimeLogPath", () => {
  it("places the log file next to the database, matching the other litestream default paths", () => {
    expect(defaultLitestreamRuntimeLogPath("/app/data/app.db")).toBe("/app/data/litestream-runtime.log");
  });
});

describe("scanLitestreamRuntimeLogText (pure)", () => {
  it("finds a real litestream compaction-failure line and reports it, trimmed", () => {
    const text = [
      'time=2026-08-08T14:35:12.123Z level=INFO msg="starting compaction monitor" level=2 interval=5m0s',
      'time=2026-08-08T14:40:12.456Z level=ERROR msg="compaction failed" level=2 error="write ltx file: extract timestamp from LTX header: non-contiguous transaction ids"'
    ].join("\n");

    const findings = scanLitestreamRuntimeLogText(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].marker).toBe("compaction failed");
    expect(findings[0].line).toContain("compaction failed");
    expect(findings[0].line).toContain("non-contiguous transaction ids");
  });

  it("finds a validation-monitor failure line independently of a compaction-failure line", () => {
    const text = 'time=2026-08-13T01:00:00.000Z level=WARN msg="validation error detected" level=1 type=gap message="ltx sequence gap"';
    const findings = scanLitestreamRuntimeLogText(text);
    expect(findings).toEqual([
      { marker: "validation error detected", line: expect.stringContaining("validation error detected") }
    ]);
  });

  it("reports nothing for routine, healthy litestream log lines", () => {
    const text = [
      'time=2026-08-13T01:00:00.000Z level=INFO msg="starting compaction monitor" level=1 interval=30s',
      'time=2026-08-13T01:00:30.000Z level=INFO msg="compaction complete" level=1 txid=00000000000123ab size=4096',
      'time=2026-08-13T02:00:00.000Z level=INFO msg="snapshot complete" txid=00000000000123ab size=1048576'
    ].join("\n");
    expect(scanLitestreamRuntimeLogText(text)).toEqual([]);
  });

  it("caps the number of findings and the length of each reported line", () => {
    const longSuffix = "x".repeat(1000);
    const lines = Array.from(
      { length: 20 },
      (_, i) => `time=2026-08-13T00:00:${String(i).padStart(2, "0")}Z level=ERROR msg="compaction failed" level=2 detail="${longSuffix}"`
    );
    const findings = scanLitestreamRuntimeLogText(lines.join("\n"));
    expect(findings.length).toBeLessThanOrEqual(5);
    for (const f of findings) {
      expect(f.line.length).toBeLessThanOrEqual(501); // 500 chars + the truncation ellipsis
    }
  });

  it("ignores blank lines and does not blow up on empty input", () => {
    expect(scanLitestreamRuntimeLogText("")).toEqual([]);
    expect(scanLitestreamRuntimeLogText("\n\n   \n")).toEqual([]);
  });
});

describe("scanLitestreamRuntimeLogFile (I/O)", () => {
  const logPaths: string[] = [];

  afterEach(() => {
    for (const p of logPaths.splice(0)) {
      try {
        unlinkSync(p);
      } catch {
        // already gone
      }
    }
  });

  function tempLogPath(): string {
    const p = join(tmpdir(), `litestream-runtime-${randomUUID()}.log`);
    logPaths.push(p);
    return p;
  }

  it("returns no findings when the file does not exist at all (litestream not running yet)", () => {
    expect(scanLitestreamRuntimeLogFile(join(tmpdir(), `does-not-exist-${randomUUID()}.log`))).toEqual([]);
  });

  it("reads a real 'compaction failed' line off disk end-to-end", () => {
    const p = tempLogPath();
    writeFileSync(
      p,
      'time=2026-08-08T14:40:12Z level=ERROR msg="compaction failed" level=2 error="non-contiguous transaction ids"\n'
    );
    const findings = scanLitestreamRuntimeLogFile(p);
    expect(findings).toHaveLength(1);
    expect(findings[0].marker).toBe("compaction failed");
  });

  it("returns no findings for an empty file", () => {
    const p = tempLogPath();
    writeFileSync(p, "");
    expect(scanLitestreamRuntimeLogFile(p)).toEqual([]);
  });

  it("only scans the tail: an old failure line pushed past the byte cap by fresh healthy lines is not reported", () => {
    const p = tempLogPath();
    const failureLine = 'time=2026-08-01T00:00:00Z level=ERROR msg="compaction failed" level=2 error="stale"\n';
    const paddingLine = `time=2026-08-13T00:00:00Z level=INFO msg="padding" data="${"p".repeat(200)}"\n`;
    // Write the failure first, then enough padding to push it out of a small tail window.
    writeFileSync(p, failureLine + paddingLine.repeat(50));
    // A generous tail (bigger than the whole file) still finds it...
    expect(scanLitestreamRuntimeLogFile(p, 1024 * 1024)).toHaveLength(1);
    // ...but a tail window smaller than the padding alone reads only recent bytes and correctly
    // reports nothing, proving the read is bounded rather than always scanning the whole file.
    expect(scanLitestreamRuntimeLogFile(p, 500)).toEqual([]);
  });

  it("finds a recent failure within a small tail window when it actually is recent", () => {
    const p = tempLogPath();
    const paddingLine = `time=2026-08-13T00:00:00Z level=INFO msg="padding" data="${"p".repeat(200)}"\n`;
    const failureLine = 'time=2026-08-13T05:00:00Z level=ERROR msg="compaction failed" level=2 error="non-contiguous"\n';
    writeFileSync(p, paddingLine.repeat(50) + failureLine);
    expect(scanLitestreamRuntimeLogFile(p, 500)).toHaveLength(1);
  });
});
