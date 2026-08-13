import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  collectLitestreamRemoteInventory,
  getLitestreamRemoteInventory,
  resolveLitestreamRemoteInventoryConfig,
  setLitestreamRemoteInventoryCache,
  summarizeLitestreamLtxPayload,
  LITESTREAM_REMOTE_LEVELS
} from "../src/lib/litestream-remote-inventory";
import { assessLitestreamTierFreshness } from "../src/lib/runtime-health";

// Covers the collector that closes defect cause #1: Litestream 0.5.12 keeps only level 0 on
// local disk, so levels 1/2/3/9 can be observed ONLY by listing the remote replica. See
// docs/rollouts/2026-08-12-backup-tier-monitor-real-coverage.md.
//
// The "remote inventory cache" and "cross-module-instance durability" describe blocks below also
// cover defect cause #2, found 2026-08-13: the cache used to live in a bare module-level
// variable, so a scheduler-side write and an API-route-side read landed in two different
// instantiations of this module and the route never saw a single collected snapshot in
// production (932 successful collector runs/24h, 0 errors, `/api/health` reporting
// `remoteInventoryState: "missing"` the entire time). See
// docs/rollouts/2026-08-13-durable-inventory-cache.md.

beforeAll(() => {
  // getLitestreamRemoteInventory/setLitestreamRemoteInventoryCache now persist through
  // src/lib/db-durable-state.ts, so this file needs its own temp DB like every other test file
  // that touches durable state (see AGENTS.md's "Tests use a temp SQLite file per run").
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-litestream-inventory-${randomUUID()}.db`)}`;
});

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
  setLitestreamRemoteInventoryCache(null);
});

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/** Credentials the collector only ever checks for PRESENCE — never reads or logs. */
const CREDENTIAL_ENV = {
  AWS_S3_BUCKET_NAME: "bucket",
  AWS_ACCESS_KEY_ID: "id",
  AWS_SECRET_ACCESS_KEY: "secret",
  AWS_S3_ENDPOINT: "https://s3.example.invalid"
};

/** Stand-in for the pinned litestream binary, so no test ever touches a real replica. */
function writeFakeLitestream(root: string, script: string): string {
  const binDir = join(root, ".bin");
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, "litestream");
  writeFileSync(binPath, `#!/bin/sh\n${script}\n`);
  chmodSync(binPath, 0o755);
  return binPath;
}

describe("summarizeLitestreamLtxPayload", () => {
  // Verbatim shape of `litestream ltx -level 2 -json` from the live production replica on
  // 2026-08-12 — the exact payload the collector has to reduce.
  const PRODUCTION_LEVEL_2_SAMPLE = [
    { level: 2, min_txid: "0000000000005249", max_txid: "00000000000052a8", size: 1742565, timestamp: "2026-08-08T00:05:04Z" },
    { level: 2, min_txid: "00000000000052a9", max_txid: "000000000000532a", size: 1930243, timestamp: "2026-08-08T00:10:06Z" },
    { level: 2, min_txid: "000000000000532b", max_txid: "00000000000053ac", size: 1825393, timestamp: "2026-08-08T00:15:07Z" }
  ];

  it("reduces a real litestream payload to the newest file's timestamp and txid", () => {
    const summary = summarizeLitestreamLtxPayload(PRODUCTION_LEVEL_2_SAMPLE, 2);
    expect(summary).toEqual({
      level: 2,
      newestAt: "2026-08-08T00:15:07.000Z",
      newestTxid: "00000000000053ac",
      fileCount: 3
    });
  });

  it("pairs the reported txid with the newest timestamp even when entries arrive out of order", () => {
    const summary = summarizeLitestreamLtxPayload(
      [
        { level: 2, max_txid: "00000000000053ac", timestamp: "2026-08-08T00:15:07Z" },
        { level: 2, max_txid: "0000000000005249", timestamp: "2026-08-07T00:00:00Z" }
      ],
      2
    );
    // The two numbers must describe the SAME file, or the wedge check would compare a fresh
    // timestamp against a txid from a different (older) file.
    expect(summary.newestAt).toBe("2026-08-08T00:15:07.000Z");
    expect(summary.newestTxid).toBe("00000000000053ac");
  });

  it("reports an empty level as zero files rather than inventing activity", () => {
    expect(summarizeLitestreamLtxPayload([], 3)).toEqual({ level: 3, newestAt: "", newestTxid: null, fileCount: 0 });
  });

  it("tolerates a non-array, null, or junk-entry payload without throwing", () => {
    expect(summarizeLitestreamLtxPayload(null, 1).fileCount).toBe(0);
    expect(summarizeLitestreamLtxPayload({ unexpected: true }, 1).fileCount).toBe(0);
    expect(summarizeLitestreamLtxPayload([null, 42, "x"], 1).fileCount).toBe(0);
  });

  it("ignores entries belonging to a different compaction level", () => {
    const summary = summarizeLitestreamLtxPayload(
      [
        { level: 9, max_txid: "00000000000f0000", timestamp: "2026-08-12T00:00:00Z" },
        { level: 2, max_txid: "000000000000e5ad", timestamp: "2026-08-08T14:35:05Z" }
      ],
      2
    );
    expect(summary).toMatchObject({ level: 2, newestTxid: "000000000000e5ad", fileCount: 1 });
  });
});

describe("resolveLitestreamRemoteInventoryConfig", () => {
  it("skips with an explicit reason when the litestream binary is absent", () => {
    const root = makeRoot("ls-inv-nobin-");
    const result = resolveLitestreamRemoteInventoryConfig({
      dbPath: join(root, "app.db"),
      env: { ...CREDENTIAL_ENV }
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.skippedReason).toContain("litestream binary");
  });

  it("skips with an explicit reason when replica credentials are not in this process", () => {
    const root = makeRoot("ls-inv-nocreds-");
    writeFakeLitestream(root, "exit 0");
    const configPath = join(root, "litestream.yml");
    writeFileSync(configPath, "dbs: []\n");

    const result = resolveLitestreamRemoteInventoryConfig({
      dbPath: join(root, "app.db"),
      env: { LITESTREAM_CONFIG_PATH: configPath, AWS_S3_BUCKET_NAME: "bucket" }
    });
    expect(result.ok).toBe(false);
    // Names the MISSING variables so an operator can act, and never echoes a value.
    expect(result.ok === false && result.skippedReason).toContain("AWS_ACCESS_KEY_ID");
  });

  it("can be switched off entirely without removing credentials", () => {
    const root = makeRoot("ls-inv-off-");
    writeFakeLitestream(root, "exit 0");
    const result = resolveLitestreamRemoteInventoryConfig({
      dbPath: join(root, "app.db"),
      env: { ...CREDENTIAL_ENV, LITESTREAM_REMOTE_INVENTORY: "off" }
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.skippedReason).toContain("disabled");
  });

  it("resolves the binary next to the database, matching the production layout", () => {
    const root = makeRoot("ls-inv-ok-");
    const binPath = writeFakeLitestream(root, "exit 0");
    const configPath = join(root, "litestream.yml");
    writeFileSync(configPath, "dbs: []\n");

    const result = resolveLitestreamRemoteInventoryConfig({
      dbPath: join(root, "app.db"),
      env: { ...CREDENTIAL_ENV, LITESTREAM_CONFIG_PATH: configPath }
    });
    expect(result.ok).toBe(true);
    // /app/data/.bin/litestream beside /app/data/app.db on the production container.
    expect(result.ok === true && result.config.binPath).toBe(binPath);
    expect(result.ok === true && result.config.levels).toEqual(LITESTREAM_REMOTE_LEVELS);
  });

  it("collects only the levels that are absent locally — never level 0", () => {
    // `-level all` measured 143s / 14.1 MB against the live replica because level 0 dominates
    // it, and level 0 is already readable locally for free. Collecting it here would make the
    // refresh an order of magnitude more expensive for no new information.
    expect(LITESTREAM_REMOTE_LEVELS).toEqual([1, 2, 3, 9]);
    expect(LITESTREAM_REMOTE_LEVELS).not.toContain(0);
  });
});

describe("collectLitestreamRemoteInventory", () => {
  it("returns a skipped snapshot, not a throw, where litestream is not installed", async () => {
    const root = makeRoot("ls-inv-skip-");
    const snapshot = await collectLitestreamRemoteInventory({
      dbPath: join(root, "app.db"),
      env: { ...CREDENTIAL_ENV }
    });
    expect(snapshot.status).toBe("skipped");
    expect(snapshot.skippedReason).toBeTruthy();
    expect(snapshot.levels).toEqual({});
    expect(Number.isFinite(Date.parse(snapshot.collectedAt))).toBe(true);
  });

  it("summarizes every remote level from the binary's JSON output", async () => {
    const root = makeRoot("ls-inv-run-");
    // Emits a one-entry listing whose txid/timestamp encode the requested level, so the test
    // proves each level was queried separately and mapped to the right key.
    writeFakeLitestream(
      root,
      [
        'level=""',
        'while [ $# -gt 0 ]; do if [ "$1" = "-level" ]; then level="$2"; fi; shift; done',
        'printf \'[{"level":%s,"min_txid":"0000000000000001","max_txid":"000000000000000%s","size":1,"timestamp":"2026-08-1%sT00:00:00Z"}]\' "$level" "$level" "$level"'
      ].join("\n")
    );
    const configPath = join(root, "litestream.yml");
    writeFileSync(configPath, "dbs: []\n");

    const snapshot = await collectLitestreamRemoteInventory({
      dbPath: join(root, "app.db"),
      env: { ...CREDENTIAL_ENV, LITESTREAM_CONFIG_PATH: configPath }
    });

    expect(snapshot.status).toBe("ok");
    expect(Object.keys(snapshot.levels).sort()).toEqual(["1", "2", "3", "9"]);
    expect(snapshot.levels["2"]).toMatchObject({ level: 2, newestTxid: "0000000000000002", fileCount: 1 });
    expect(snapshot.levels["9"]).toMatchObject({ level: 9, newestTxid: "0000000000000009" });
    expect(snapshot.levelErrors).toEqual({});
  });

  it("records a per-level error and reports 'partial' when only some levels list successfully", async () => {
    const root = makeRoot("ls-inv-partial-");
    writeFakeLitestream(
      root,
      [
        'level=""',
        'while [ $# -gt 0 ]; do if [ "$1" = "-level" ]; then level="$2"; fi; shift; done',
        'if [ "$level" = "2" ]; then echo "Error: bucket required for s3 replica" >&2; exit 1; fi',
        'printf \'[{"level":%s,"max_txid":"0000000000000001","timestamp":"2026-08-12T00:00:00Z"}]\' "$level"'
      ].join("\n")
    );
    const configPath = join(root, "litestream.yml");
    writeFileSync(configPath, "dbs: []\n");

    const snapshot = await collectLitestreamRemoteInventory({
      dbPath: join(root, "app.db"),
      env: { ...CREDENTIAL_ENV, LITESTREAM_CONFIG_PATH: configPath }
    });

    // A single failing level must not discard the three that worked — partial coverage that
    // says which level is missing beats no coverage at all.
    expect(snapshot.status).toBe("partial");
    expect(Object.keys(snapshot.levelErrors)).toEqual(["2"]);
    expect(snapshot.levels["1"]).toBeDefined();
    expect(snapshot.levels["9"]).toBeDefined();
  });

  it("reports 'failed' when every level errors, without throwing", async () => {
    const root = makeRoot("ls-inv-failed-");
    writeFakeLitestream(root, 'echo "Error: dial tcp: connection refused" >&2\nexit 1');
    const configPath = join(root, "litestream.yml");
    writeFileSync(configPath, "dbs: []\n");

    const snapshot = await collectLitestreamRemoteInventory({
      dbPath: join(root, "app.db"),
      env: { ...CREDENTIAL_ENV, LITESTREAM_CONFIG_PATH: configPath }
    });
    expect(snapshot.status).toBe("failed");
    expect(Object.keys(snapshot.levelErrors).sort()).toEqual(["1", "2", "3", "9"]);
  });

  it("treats unparseable output as a level error rather than fabricating a summary", async () => {
    const root = makeRoot("ls-inv-junk-");
    writeFakeLitestream(root, 'echo "not json at all"');
    const configPath = join(root, "litestream.yml");
    writeFileSync(configPath, "dbs: []\n");

    const snapshot = await collectLitestreamRemoteInventory({
      dbPath: join(root, "app.db"),
      env: { ...CREDENTIAL_ENV, LITESTREAM_CONFIG_PATH: configPath }
    });
    expect(snapshot.status).toBe("failed");
    expect(snapshot.levelErrors["1"]).toContain("unparseable");
  });
});

describe("remote inventory cache", () => {
  it("starts empty so a fresh process reports 'not collected yet' instead of stale numbers", () => {
    expect(getLitestreamRemoteInventory()).toBeNull();
  });

  it("round-trips a primed snapshot for the health and admin routes to read", () => {
    const snapshot = {
      collectedAt: "2026-08-12T23:20:00.000Z",
      status: "ok" as const,
      levels: { "2": { level: 2, newestAt: "2026-08-08T14:35:05.000Z", newestTxid: "000000000000e5ad", fileCount: 171 } },
      levelErrors: {},
      skippedReason: null
    };
    setLitestreamRemoteInventoryCache(snapshot);
    expect(getLitestreamRemoteInventory()).toEqual(snapshot);
  });
});

// Reproduces the actual 2026-08-12/13 production defect: the scheduler (writer) and the API
// route handlers (reader) get SEPARATE instantiations of this module even inside one OS process,
// so a bare module-level `cachedInventory` variable written by one instance is invisible to the
// other. `vi.resetModules()` + a fresh `await import(...)` is the standard way to force a
// genuinely independent module instance in Vitest — see test/trigger-durability.test.ts for the
// same technique used against a different durable-state consumer. Every assertion in this block
// FAILS against the pre-fix module-level-variable implementation, because a freshly imported
// instance's `cachedInventory` starts `null` and nothing here would ever repopulate it.
describe("cross-module-instance durability (the production bug)", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("a snapshot written by one module instance is visible to a completely separate module instance", async () => {
    const writer = await import("../src/lib/litestream-remote-inventory");
    const snapshot = {
      collectedAt: "2026-08-13T12:00:00.000Z",
      status: "ok" as const,
      levels: { "1": { level: 1, newestAt: "2026-08-13T11:58:00.000Z", newestTxid: "000000000002324c", fileCount: 5635 } },
      levelErrors: {},
      skippedReason: null
    };
    writer.setLitestreamRemoteInventoryCache(snapshot);

    // Force a brand-new instantiation of the module (and everything it imports, including
    // src/lib/db-durable-state.ts and src/lib/db.ts) — its own `cachedInventory` binding starts
    // at `null`, exactly like the scheduler and an API route bundle really do in production.
    vi.resetModules();
    const reader = await import("../src/lib/litestream-remote-inventory");
    expect(reader).not.toBe(writer);
    expect(reader.getLitestreamRemoteInventory()).toEqual(snapshot);

    // Clean up through whichever instance — both point at the same durable_state row.
    reader.setLitestreamRemoteInventoryCache(null);
  });

  it("a real scheduler collection persisted by the writer makes remoteInventoryState 'ok' (not 'missing') for a fresh reader instance", async () => {
    const root = makeRoot("ls-inv-cross-instance-");
    writeFakeLitestream(
      root,
      [
        'level=""',
        'while [ $# -gt 0 ]; do if [ "$1" = "-level" ]; then level="$2"; fi; shift; done',
        'printf \'[{"level":%s,"min_txid":"0000000000000001","max_txid":"000000000000000%s","size":1,"timestamp":"2026-08-1%sT00:00:00Z"}]\' "$level" "$level" "$level"'
      ].join("\n")
    );
    const configPath = join(root, "litestream.yml");
    writeFileSync(configPath, "dbs: []\n");

    const writer = await import("../src/lib/litestream-remote-inventory");
    const result = await writer.refreshLitestreamRemoteInventoryIfDue({
      dbPath: join(root, "app.db"),
      env: { ...CREDENTIAL_ENV, LITESTREAM_CONFIG_PATH: configPath },
      nowMs: Date.parse("2026-08-13T12:00:00.000Z")
    });
    expect(result).toEqual({ ran: true, status: "ok" });

    vi.resetModules();
    const reader = await import("../src/lib/litestream-remote-inventory");
    const inventory = reader.getLitestreamRemoteInventory();
    expect(inventory?.status).toBe("ok");

    const report = assessLitestreamTierFreshness(undefined, {
      remoteInventory: inventory,
      nowMs: Date.parse("2026-08-13T12:05:00.000Z")
    });
    expect(report.remoteInventoryState).toBe("ok");
    expect(report.remoteInventoryState).not.toBe("missing");
    // Levels 1/2/3/9 exist only in the remote replica; with a real 'ok' inventory in hand they
    // must grade as known, not "not-observable" — the exact symptom PR #2665 shipped to fix and
    // the durable-state bug silently defeated.
    for (const tier of report.tiers) {
      if (tier.tier === "0") continue;
      expect(tier.state).toBe("known");
    }

    reader.setLitestreamRemoteInventoryCache(null);
  });
});
