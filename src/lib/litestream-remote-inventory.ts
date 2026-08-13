/**
 * Scheduled inventory of the REMOTE Litestream replica, broken out per compaction level.
 *
 * WHY THIS EXISTS
 * ---------------
 * Litestream 0.5.12 keeps only level 0 in the local `ltx/0/` cache; levels 1, 2, 3 and 9 are
 * compacted straight into the remote replica (Backblaze B2) and never appear on local disk.
 * Verified on the live container 2026-08-12: `/app/data/.app.db-litestream/ltx/` contained
 * exactly one entry, `0`. Any monitor that grades higher levels from local files is therefore
 * structurally blind to them, which is precisely how a wedged level-2 compaction ran
 * unnoticed in production while every health signal stayed green.
 *
 * The IPC control socket cannot close the gap either. Litestream 0.5.12 serves exactly two
 * routes there — `/list` (path, status, last_sync_at) and `/info` (version, pid, uptime,
 * started_at, database_count); everything else 404s. Neither carries per-level data. Probed
 * against the live daemon on 2026-08-12.
 *
 * What DOES work is the pinned binary's own reader: `litestream ltx -level N -json <db>` lists
 * the remote LTX inventory for one level, including each file's txid range and timestamp. The
 * app process can run it because it is a CHILD of the litestream daemon
 * (`litestream replicate -exec "next start"` in scripts/coolify-prod-start.sh) and therefore
 * inherits the same AWS_* replica credentials.
 *
 * COST — WHY THIS IS SCHEDULED AND NEVER INLINE
 * ---------------------------------------------
 * Measured against the live replica on 2026-08-12:
 *   level 1  -> 8.3s, 5,635 files, 887 KB of JSON
 *   level 2  -> 0.9s,   171 files
 *   level 3  -> 0.7s,    15 files
 *   level 9  -> 0.7s,     8 files
 *   -level all -> 143s, 90,500 files, 14.1 MB    <- never used; level 0 dominates it
 * Roughly 11s and ~9 B2 LIST calls per refresh. At the 30-minute cadence below that is ~430
 * LIST calls/day, comfortably inside B2's free daily transaction allowance, and it keeps every
 * one of those seconds off the `/api/health` request path.
 *
 * Level 0 is deliberately NOT collected here: it is already readable locally, in real time,
 * for free, and it is the level that makes `-level all` unusable.
 */

// Bare specifiers (not `node:`-prefixed) and a runtime `require` for child_process: this
// module is reachable from src/lib/scheduler.ts, which Next's webpack build traverses, and
// webpack rejects `node:` URIs there. The eval-require for child_process follows the existing
// precedent in src/lib/data-providers.ts (runWebullUnofficialScript) for the same reason.
import { accessSync, constants } from "fs";
import { dirname, join } from "path";
import type {
  LitestreamRemoteInventorySnapshot,
  LitestreamRemoteLevelSummary
} from "./runtime-health";

type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; encoding: "utf8"; windowsHide: boolean },
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => void;

function loadExecFile(): ExecFileFn {
  const requireFn = eval("require") as (id: string) => unknown;
  return (requireFn("child_process") as { execFile: ExecFileFn }).execFile;
}

/** Levels that exist only in the remote replica. Level 0 is read locally instead. */
export const LITESTREAM_REMOTE_LEVELS: readonly number[] = [1, 2, 3, 9];

export const LITESTREAM_REMOTE_INVENTORY_INTERVAL_MS = 30 * 60_000;
/** After a failed collection, retry sooner than the normal cadence without hammering B2. */
export const LITESTREAM_REMOTE_INVENTORY_RETRY_INTERVAL_MS = 10 * 60_000;
/** Level 1 measured 8.3s; 45s leaves headroom for a slow replica without hanging a lane. */
const PER_LEVEL_TIMEOUT_MS = 45_000;
/** Level 1's listing is ~887 KB today; 32 MB tolerates years of growth before truncating. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface LitestreamRemoteInventoryConfig {
  binPath: string;
  configPath: string;
  dbPath: string;
  levels: readonly number[];
}

export type LitestreamRemoteInventoryResolution =
  | { ok: true; config: LitestreamRemoteInventoryConfig }
  | { ok: false; skippedReason: string };

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = String(env.LITESTREAM_REMOTE_INVENTORY ?? "").trim().toLowerCase();
  return raw === "off" || raw === "0" || raw === "false" || raw === "no";
}

/**
 * Decide whether a remote inventory can be collected here, WITHOUT reading any secret value.
 *
 * Credential checks are presence-only (`Boolean(env.X)`); this module never logs, returns, or
 * interpolates a credential, and the child process inherits them through `process.env` rather
 * than receiving them on a command line.
 */
export function resolveLitestreamRemoteInventoryConfig(options: {
  dbPath: string;
  env?: Readonly<Record<string, string | undefined>>;
}): LitestreamRemoteInventoryResolution {
  const env = options.env ?? process.env;
  if (isDisabled(env)) {
    return { ok: false, skippedReason: "disabled by LITESTREAM_REMOTE_INVENTORY" };
  }

  const binPath = env.LITESTREAM_BIN?.trim() || join(dirname(options.dbPath), ".bin", "litestream");
  if (!isExecutable(binPath)) {
    return { ok: false, skippedReason: "the litestream binary is not available in this environment" };
  }

  const configPath = env.LITESTREAM_CONFIG_PATH?.trim() || "/app/litestream.coolify.yml";
  if (!isReadable(configPath)) {
    return { ok: false, skippedReason: "the litestream config file is not readable in this environment" };
  }

  const missing = ["AWS_S3_BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_S3_ENDPOINT"]
    .filter((name) => !String(env[name] ?? "").trim());
  if (missing.length > 0) {
    return { ok: false, skippedReason: `replica credentials are not present in this process (${missing.join(", ")})` };
  }

  return { ok: true, config: { binPath, configPath, dbPath: options.dbPath, levels: LITESTREAM_REMOTE_LEVELS } };
}

/**
 * Reduce one `litestream ltx -level N -json` payload to the newest file at that level.
 *
 * Pure and defensive: the JSON shape is Litestream's, not ours, so every field is re-validated
 * rather than trusted. Entries for other levels are ignored rather than silently merged.
 */
export function summarizeLitestreamLtxPayload(payload: unknown, level: number): LitestreamRemoteLevelSummary {
  const entries = Array.isArray(payload) ? payload : [];
  let newestAtMs = Number.NEGATIVE_INFINITY;
  let newestAt: string | null = null;
  let newestTxid: string | null = null;
  let fileCount = 0;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { level?: unknown; max_txid?: unknown; timestamp?: unknown };
    if (typeof record.level === "number" && record.level !== level) continue;
    fileCount += 1;

    if (typeof record.timestamp === "string") {
      const parsed = Date.parse(record.timestamp);
      if (Number.isFinite(parsed) && parsed > newestAtMs) {
        newestAtMs = parsed;
        newestAt = new Date(parsed).toISOString();
        // Pair the txid with the newest timestamp rather than taking a global max, so the two
        // reported numbers always describe the same file.
        newestTxid = typeof record.max_txid === "string" ? record.max_txid.toLowerCase() : null;
      }
    }
  }

  return { level, newestAt: newestAt ?? "", newestTxid, fileCount: newestAt ? fileCount : 0 };
}

function runLitestreamLtx(config: LitestreamRemoteInventoryConfig, level: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Every argument is a fixed literal or a resolved path — no caller-controlled input reaches
    // the argv, and `execFile` never invokes a shell.
    loadExecFile()(
      config.binPath,
      ["ltx", "-level", String(level), "-json", "-config", config.configPath, config.dbPath],
      { timeout: PER_LEVEL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8", windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(new Error(error.message.split("\n")[0].slice(0, 200)));
          return;
        }
        const text = stdout.trim();
        if (!text) {
          resolve([]);
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error("litestream ltx returned unparseable JSON"));
        }
      }
    );
  });
}

/** Collect every remote level once. Levels are listed sequentially so a refresh never
 *  opens four concurrent B2 listings from a process that also serves requests. */
export async function collectLitestreamRemoteInventory(options: {
  dbPath: string;
  env?: Readonly<Record<string, string | undefined>>;
  nowMs?: number;
}): Promise<LitestreamRemoteInventorySnapshot> {
  const collectedAt = new Date(options.nowMs ?? Date.now()).toISOString();
  const resolution = resolveLitestreamRemoteInventoryConfig({ dbPath: options.dbPath, env: options.env });
  if (!resolution.ok) {
    return { collectedAt, status: "skipped", levels: {}, levelErrors: {}, skippedReason: resolution.skippedReason };
  }

  const levels: Record<string, LitestreamRemoteLevelSummary> = {};
  const levelErrors: Record<string, string> = {};

  for (const level of resolution.config.levels) {
    try {
      const payload = await runLitestreamLtx(resolution.config, level);
      levels[String(level)] = summarizeLitestreamLtxPayload(payload, level);
    } catch (error) {
      levelErrors[String(level)] = error instanceof Error ? error.message : String(error);
    }
  }

  const failed = Object.keys(levelErrors).length;
  const status = failed === 0 ? "ok" : failed === resolution.config.levels.length ? "failed" : "partial";
  return { collectedAt, status, levels, levelErrors, skippedReason: null };
}

// The snapshot lives in module memory rather than the database: `next start` serves the
// scheduler and every API route from one process, so the reader and the writer are the same
// process, and a restart correctly reports "not collected yet" instead of resurrecting numbers
// from a previous replica state.
let cachedInventory: LitestreamRemoteInventorySnapshot | null = null;
let lastAttemptAtMs = 0;

export function getLitestreamRemoteInventory(): LitestreamRemoteInventorySnapshot | null {
  return cachedInventory;
}

/** Test/refresh seam — lets route tests exercise the rendering path without spawning anything. */
export function setLitestreamRemoteInventoryCache(snapshot: LitestreamRemoteInventorySnapshot | null): void {
  cachedInventory = snapshot;
}

export function resetLitestreamRemoteInventoryCadence(): void {
  lastAttemptAtMs = 0;
}

export interface LitestreamRemoteInventoryRunResult {
  ran: boolean;
  status: LitestreamRemoteInventorySnapshot["status"] | "not-due";
}

/**
 * Scheduler entry point. Cadence-gated, self-guarded, and never throws into the tick.
 *
 * Deliberately NOT leader-gated: the snapshot is consumed by the `/api/health` and admin
 * routes served by THIS process, so each process needs its own. There is one production
 * container, so this is also one collector.
 */
export async function refreshLitestreamRemoteInventoryIfDue(options: {
  dbPath?: string;
  env?: Readonly<Record<string, string | undefined>>;
  nowMs?: number;
} = {}): Promise<LitestreamRemoteInventoryRunResult> {
  const nowMs = options.nowMs ?? Date.now();
  const intervalMs = cachedInventory && cachedInventory.status === "ok"
    ? LITESTREAM_REMOTE_INVENTORY_INTERVAL_MS
    : LITESTREAM_REMOTE_INVENTORY_RETRY_INTERVAL_MS;
  if (lastAttemptAtMs !== 0 && nowMs - lastAttemptAtMs < intervalMs) {
    return { ran: false, status: "not-due" };
  }
  lastAttemptAtMs = nowMs;

  let dbPath = options.dbPath;
  if (!dbPath) {
    const { databasePath } = await import("./db");
    dbPath = databasePath();
  }

  try {
    const snapshot = await collectLitestreamRemoteInventory({ dbPath, env: options.env, nowMs });
    cachedInventory = snapshot;
    return { ran: true, status: snapshot.status };
  } catch (error) {
    // A total failure must not wipe the previous snapshot: stale-but-labelled data is more
    // useful than none, and assessLitestreamTierFreshness ages it out on its own.
    console.error("[litestream-remote-inventory] collection failed:", error);
    return { ran: true, status: "failed" };
  }
}
