import { request } from "node:http";
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getGitSha } from "./git-sha";

export interface RuntimeReleaseIdentity {
  sha: string | null;
  processStartedAt: string;
  processUptimeSeconds: number;
}

export type LitestreamRuntimeHealth =
  | {
      state: "known";
      source: "ipc" | "file";
      status: string;
      lastSyncAt: string | null;
      ageSeconds: number | null;
      timestampState: "valid" | "missing" | "invalid";
    }
  | {
      state: "unknown";
      source: "none";
    };

export type LitestreamDegradationReason =
  | "unavailable"
  | "file-unverified"
  | "stale"
  | "stopped"
  | "never-synced"
  | "invalid-sync-time";

export interface LitestreamHealthAssessment {
  degraded: boolean;
  reasons: LitestreamDegradationReason[];
}

export const LITESTREAM_STARTUP_GRACE_SECONDS = 5 * 60;
export const LITESTREAM_STALE_AFTER_SECONDS = 60 * 60;
const LITESTREAM_IPC_MAX_RESPONSE_BYTES = 64 * 1024;
const LITESTREAM_FILE_SCAN_MAX_DEPTH = 8;
const LITESTREAM_CLOCK_SKEW_MS = 60_000;
/**
 * Per-directory `stat()` budget for the local scans below.
 *
 * The previous bound was a flat 256 entries across the whole scan, and hitting it made the
 * scan return `null` — i.e. report NOTHING rather than something imprecise. That was the
 * second of the two bugs that left this monitor at zero production coverage: `ltx/0` holds
 * ~1,000+ LTX files in normal operation (1,078 measured on the live container on 2026-08-12),
 * so level 0 — the one level that IS readable locally — silently degraded to "unknown" on
 * every single health check.
 *
 * Raising the cap to another magic number would only move the cliff. Instead the scan no
 * longer needs to touch every entry: Litestream 0.5.x names each file
 * `<minTXID>-<maxTXID>.ltx` with zero-padded hex transaction ids, so lexicographic filename
 * order IS write order (verified on the live replica: the lexicographically greatest name in
 * `ltx/0` also carried the newest mtime). Selecting the highest-named few entries in a single
 * O(n) pass and stat-ing only those costs one `readdir` plus <= 8 `stat` calls no matter how
 * large the directory grows. Sampling several rather than exactly one tolerates a small
 * name/time inversion (e.g. a slow write finishing out of order) at negligible cost.
 */
const LITESTREAM_DIR_STAT_SAMPLE = 8;
/** Recursion guard for the whole-tree diagnostic scan; bounds work without blinding the result. */
const LITESTREAM_FILE_SCAN_MAX_DIRECTORIES = 512;

const PROCESS_STARTED_AT_MS = Date.now() - Math.round(process.uptime() * 1000);
/** Public-safe release metadata. Only hexadecimal commit ids are exposed. */
export function runtimeReleaseIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
  nowMs: number = Date.now()
): RuntimeReleaseIdentity {
  return {
    sha: getGitSha(env as Record<string, string | undefined>) ?? null,
    processStartedAt: new Date(PROCESS_STARTED_AT_MS).toISOString(),
    processUptimeSeconds: Math.max(0, Math.round((nowMs - PROCESS_STARTED_AT_MS) / 1000))
  };
}

function ageSeconds(iso: string, nowMs: number): number | null {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp) || timestamp > nowMs + LITESTREAM_CLOCK_SKEW_MS) return null;
  return Math.max(0, Math.round((nowMs - timestamp) / 1000));
}

export function isLitestreamReplicatingStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  // v0.5.12 documents `replicating`; the original v0.5.8 IPC example used `active`.
  return normalized === "replicating" || normalized === "active";
}

/** Litestream 0.5.x keeps metadata in a hidden sibling directory by default. */
export function defaultLitestreamStatePath(dbPath: string): string {
  return join(dirname(dbPath), `.${basename(dbPath)}-litestream`);
}

/**
 * Default Unix socket for Litestream's local IPC control plane (`GET /list`).
 * Colocate with the DB so the non-root app user can bind it in containers —
 * `/var/run/litestream.sock` is root-only and leaves production health stuck
 * on `storageDegraded: unavailable` despite healthy R2 replication.
 */
export function defaultLitestreamSocketPath(dbPath: string): string {
  return join(dirname(dbPath), "litestream.sock");
}

/**
 * Decide whether the available signal proves the production R2 recovery path is healthy.
 * File mtimes are retained as diagnostics only; they do not prove a successful remote upload.
 */
export function assessLitestreamRuntimeHealth(
  health: LitestreamRuntimeHealth,
  options: {
    liveMode: boolean;
    processUptimeSeconds: number;
    latestLocalActivityAtMs?: number | null;
    startupGraceSeconds?: number;
    staleAfterSeconds?: number;
  }
): LitestreamHealthAssessment {
  const reasons: LitestreamDegradationReason[] = [];
  const startupGraceSeconds = options.startupGraceSeconds ?? LITESTREAM_STARTUP_GRACE_SECONDS;
  const staleAfterSeconds = options.staleAfterSeconds ?? LITESTREAM_STALE_AFTER_SECONDS;

  if (health.state === "unknown") {
    if (options.liveMode) reasons.push("unavailable");
    return { degraded: reasons.length > 0, reasons };
  }

  if (health.source === "file") {
    if (options.liveMode) reasons.push("file-unverified");
    return { degraded: reasons.length > 0, reasons };
  }

  if (health.timestampState === "invalid") {
    reasons.push("invalid-sync-time");
  } else if (!isLitestreamReplicatingStatus(health.status)) {
    reasons.push("stopped");
  } else if (
    options.liveMode
    && health.lastSyncAt === null
    && options.processUptimeSeconds >= startupGraceSeconds
  ) {
    reasons.push("never-synced");
  }

  const lastSyncAtMs = health.lastSyncAt ? Date.parse(health.lastSyncAt) : Number.NaN;
  const localActivityAtMs = options.latestLocalActivityAtMs ?? Number.NaN;
  if (
    health.ageSeconds !== null
    && health.ageSeconds > staleAfterSeconds
    && Number.isFinite(lastSyncAtMs)
    && Number.isFinite(localActivityAtMs)
    && localActivityAtMs > lastSyncAtMs
  ) {
    reasons.push("stale");
  }

  return { degraded: reasons.length > 0, reasons };
}

/** Parse Litestream 0.5.x IPC `GET /list` without trusting its JSON shape. */
export function parseLitestreamListPayload(
  payload: unknown,
  dbPath: string,
  nowMs: number = Date.now()
): LitestreamRuntimeHealth | null {
  if (!payload || typeof payload !== "object") return null;
  const databases = (payload as { databases?: unknown }).databases;
  if (!Array.isArray(databases)) return null;
  const database = databases.find((item) => {
    if (!item || typeof item !== "object") return false;
    return (item as { path?: unknown }).path === dbPath;
  });
  if (!database || typeof database !== "object") return null;

  const record = database as { status?: unknown; last_sync_at?: unknown; lastSyncAt?: unknown };
  const status = typeof record.status === "string" && record.status.trim() ? record.status.trim() : "unknown";
  const rawLastSyncAt = typeof record.last_sync_at === "string"
    ? record.last_sync_at
    : typeof record.lastSyncAt === "string"
      ? record.lastSyncAt
      : null;
  const parsedAgeSeconds = rawLastSyncAt ? ageSeconds(rawLastSyncAt, nowMs) : null;
  const timestampState = rawLastSyncAt === null
    ? "missing"
    : parsedAgeSeconds === null
      ? "invalid"
      : "valid";
  const lastSyncAt = timestampState === "valid" ? rawLastSyncAt : null;

  return {
    state: "known",
    source: "ipc",
    status,
    lastSyncAt,
    ageSeconds: parsedAgeSeconds,
    timestampState
  };
}

/**
 * Newest mtime among a directory's own files, using a bounded `stat()` budget.
 *
 * Small directories are stat-ed exhaustively (exact). Larger ones fall back to the
 * highest-named LITESTREAM_DIR_STAT_SAMPLE entries — see that constant for why filename order
 * is a sound proxy for write order in Litestream's LTX directories, which are the only
 * directories in this tree that ever grow large.
 */
function newestMtimeAmong(dir: string, names: readonly string[]): number | null {
  if (names.length === 0) return null;

  let candidates: readonly string[];
  if (names.length <= LITESTREAM_DIR_STAT_SAMPLE) {
    candidates = names;
  } else {
    // Single O(n) pass keeping the highest-named LITESTREAM_DIR_STAT_SAMPLE names. `top` is
    // kept sorted ascending, so `top[0]` is always the weakest candidate held.
    const top: string[] = [];
    for (const name of names) {
      if (top.length < LITESTREAM_DIR_STAT_SAMPLE) {
        top.push(name);
        if (top.length === LITESTREAM_DIR_STAT_SAMPLE) top.sort();
        continue;
      }
      if (name > top[0]) {
        top[0] = name;
        top.sort();
      }
    }
    candidates = top;
  }

  let newestMs = 0;
  for (const name of candidates) {
    try {
      const stat = statSync(join(dir, name));
      if (stat.isFile()) newestMs = Math.max(newestMs, stat.mtimeMs);
    } catch {
      // Raced deletion (retention prune) — the remaining candidates still answer the question.
    }
  }
  return newestMs > 0 ? newestMs : null;
}

/** `<minTXID>-<maxTXID>.ltx` with zero-padded hex ids (Litestream 0.5.x). */
export function maxTxidFromLtxFilename(name: string): string | null {
  const match = /^([0-9a-f]+)-([0-9a-f]+)\.ltx$/i.exec(name);
  return match ? match[2].toLowerCase() : null;
}

/** Numeric ordering for zero-padded hex transaction ids of possibly differing widths. */
export function compareLitestreamTxid(a: string, b: string): number {
  const left = a.replace(/^0+/, "") || "0";
  const right = b.replace(/^0+/, "") || "0";
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

interface LocalLtxObservation {
  newestMs: number;
  newestTxid: string | null;
  fileCount: number;
}

/** Read one `ltx/<level>/` directory. Returns null when the directory holds no LTX files. */
function readLocalLtxDirectory(dir: string): LocalLtxObservation | null {
  const names = readdirSync(dir).filter((name) => name.endsWith(".ltx"));
  if (names.length === 0) return null;
  const newestMs = newestMtimeAmong(dir, names);
  if (newestMs === null) return null;

  let newestTxid: string | null = null;
  for (const name of names) {
    const txid = maxTxidFromLtxFilename(name);
    if (txid && (newestTxid === null || compareLitestreamTxid(txid, newestTxid) > 0)) newestTxid = txid;
  }
  return { newestMs, newestTxid, fileCount: names.length };
}

/**
 * Newest mtime anywhere under `target`, for the whole-tree diagnostic fallback.
 *
 * Bounded by directory count and depth rather than by total entries, and — unlike the version
 * this replaced — a directory that exceeds the per-directory `stat()` budget is SAMPLED rather
 * than turned into a `null` result. Refusing to answer was how the old bound blinded both this
 * fallback and the per-tier check in production.
 */
function newestFileMtimeMs(target: string): number | null {
  let newestMs = 0;
  let directories = 0;
  const pending: Array<{ path: string; depth: number }> = [{ path: target, depth: 0 }];

  while (pending.length > 0 && directories <= LITESTREAM_FILE_SCAN_MAX_DIRECTORIES) {
    const current = pending.pop()!;
    let dirents;
    try {
      dirents = readdirSync(current.path, { withFileTypes: true });
    } catch {
      // Not a directory (the scan root may be a plain file), or unreadable.
      try {
        const stat = statSync(current.path);
        if (stat.isFile()) newestMs = Math.max(newestMs, stat.mtimeMs);
      } catch {
        // Unreadable — nothing to contribute.
      }
      continue;
    }

    directories += 1;
    const fileNames: string[] = [];
    for (const entry of dirents) {
      if (entry.isDirectory()) {
        if (current.depth < LITESTREAM_FILE_SCAN_MAX_DEPTH) {
          pending.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
        }
      } else {
        fileNames.push(entry.name);
      }
    }
    const newestHere = newestMtimeAmong(current.path, fileNames);
    if (newestHere !== null) newestMs = Math.max(newestMs, newestHere);
  }

  return newestMs > 0 ? newestMs : null;
}

/**
 * Litestream 0.5.x compaction levels this app's config actually exercises.  The original
 * 2026-08-11 version of this monitor watched only 0/1/9 on the assumption that "levels 2-8
 * are unused here" — disproven within a day: litestream's own boot log starts compaction
 * monitors for levels 1 (30s), 2 (5m), 3 (1h), and 9 (24h), and the 2026-08-12 production
 * wedge was at LEVEL 2 ("non-contiguous transaction ids", byte-identical retry every 5
 * minutes) — a failure the 0/1/9 monitor was structurally blind to.  All active levels are
 * watched now.
 *
 * Widening the list to 0/1/2/3/9 was necessary but nowhere near sufficient: the 2026-08-11/12
 * implementation graded every level from local `ltx/<level>/` mtimes, and levels 1/2/3/9 have
 * no local directory at all, so all five levels reported "unknown" in production — zero
 * coverage while appearing to cover everything.  See assessLitestreamTierFreshness below for
 * the two-source design that replaced it.
 */
export type LitestreamCompactionTier = "0" | "1" | "2" | "3" | "9";

export const LITESTREAM_COMPACTION_TIERS: readonly LitestreamCompactionTier[] = ["0", "1", "2", "3", "9"];

/** Plain-English names for the admin UI and alert text. */
export const LITESTREAM_TIER_LABELS: Record<LitestreamCompactionTier, string> = {
  "0": "Continuous Sync",
  "1": "Compaction",
  "2": "Deep Compaction",
  "3": "Hourly Rollup",
  "9": "Daily Snapshot"
};

/**
 * Per-tier staleness thresholds (seconds) — a finer-grained COMPLEMENT to
 * LITESTREAM_STALE_AFTER_SECONDS above, not a replacement. That constant, and the IPC
 * `/list` signal it grades, only describe the database's overall last-sync time, which
 * tracks level 0 and keeps reporting fresh even when a higher compaction level is wedged.
 * That gap is exactly what let a stuck level-1 B2 compaction anchor run silently for 27+
 * hours in production on 2026-08-11 (level 0 kept succeeding every ~60s the entire time —
 * see docs/rollouts/2026-08-09-event-loop-stall-instrumentation.md) before anyone noticed.
 * Reasoning per tier:
 *   - level 0: litestream.coolify.yml syncs every 60s. 10 minutes is ~10x that cadence,
 *     generous headroom for one missed tick while still catching a genuinely stuck sync
 *     in minutes rather than hours.
 *   - level 1: compaction is periodic, not continuous, so healthy operation naturally goes
 *     quiet between runs — there is no fixed interval to anchor a tight threshold to. 4
 *     hours tolerates ordinary gaps while catching a stuck compactor (this incident's
 *     failure mode) in a few hours instead of the 27+ hours it actually took.
 *   - level 2: 5-minute monitor interval, but output only appears when enough level-1
 *     input has accumulated — quiet stretches are normal.  2 hours (24x the interval)
 *     still catches a wedged retry loop (the 2026-08-12 incident shape) same-day.
 *   - level 3: 1-hour monitor interval, same accumulation caveat. 6 hours.
 *   - level 9: `snapshot.interval: 24h`. 30 hours (24h + 6h buffer) rides out one
 *     delayed/retried run without false-alarming on ordinary scheduling jitter.
 *
 * Every threshold above 10 minutes is graded from the remote replica inventory, which
 * refreshes every 30 minutes and is discarded once it exceeds
 * LITESTREAM_REMOTE_INVENTORY_MAX_AGE_SECONDS (90 min).  Both are far below the tightest
 * remote threshold (level 2 at 2h), so collection cadence never drives a verdict.
 */
export const LITESTREAM_TIER_STALE_AFTER_SECONDS: Record<LitestreamCompactionTier, number> = {
  "0": 10 * 60,
  "1": 4 * 60 * 60,
  "2": 2 * 60 * 60,
  "3": 6 * 60 * 60,
  "9": 30 * 60 * 60
};

/** Where a tier's freshness signal actually came from. */
export type LitestreamTierSource = "local-ltx" | "remote-inventory";

/**
 * Why a tier could not be graded. Every non-"known" tier carries one of these plus a
 * human-readable `detail`, because a bare "unknown" reads as "we checked and found nothing"
 * when the truth is usually "we structurally cannot see this from here" — the exact
 * misreading that let five all-"unknown" tiers look like coverage for a day in production.
 */
export type LitestreamTierUnobservableReason =
  | "no-state-path"
  | "local-scan-failed"
  | "remote-inventory-missing"
  | "remote-inventory-stale"
  | "remote-inventory-failed"
  | "no-activity-recorded";

export type LitestreamTierFreshness =
  | {
      tier: LitestreamCompactionTier;
      label: string;
      state: "known";
      source: LitestreamTierSource;
      newestActivityAt: string;
      newestTxid: string | null;
      ageSeconds: number;
      thresholdSeconds: number;
      degraded: boolean;
    }
  | {
      tier: LitestreamCompactionTier;
      label: string;
      state: "not-observable";
      thresholdSeconds: number;
      reason: LitestreamTierUnobservableReason;
      detail: string;
    };

/** Overall provenance of the remote half of the report, for the admin panel's banner. */
export type LitestreamRemoteInventoryState = "ok" | "partial" | "failed" | "skipped" | "missing" | "stale";

export interface LitestreamTierFreshnessReport {
  tiers: LitestreamTierFreshness[];
  degraded: boolean;
  /** Count of tiers carrying a real signal — the honest "how much do we actually cover?" number. */
  observedTiers: number;
  notObservableTiers: number;
  remoteInventoryState: LitestreamRemoteInventoryState;
  remoteInventoryCollectedAt: string | null;
}

/**
 * One compaction level's newest LTX file in the REMOTE replica, as collected out-of-band by
 * src/lib/litestream-remote-inventory.ts. Declared here (rather than imported) so this module
 * stays dependency-light and unit-testable without a database or a child process.
 */
export interface LitestreamRemoteLevelSummary {
  level: number;
  newestAt: string;
  newestTxid: string | null;
  fileCount: number;
}

export interface LitestreamRemoteInventorySnapshot {
  collectedAt: string;
  status: "ok" | "partial" | "failed" | "skipped";
  /** Keyed by level as a decimal string. Absent levels were not collected. */
  levels: Record<string, LitestreamRemoteLevelSummary>;
  /** Keyed by level; present when that level's listing failed. */
  levelErrors: Record<string, string>;
  skippedReason: string | null;
}

/**
 * How old a collected inventory may be before its levels stop counting as observed.
 *
 * Without this bound a refresher that died would freeze `newestAt` while wall-clock time kept
 * moving, so every remote tier would eventually "age out" and report a wedge that is really
 * just a dead collector. 90 minutes is 3x the 30-minute refresh cadence: it rides out two
 * missed refreshes, and is far inside the tightest remote threshold (level 2 at 2 hours).
 */
export const LITESTREAM_REMOTE_INVENTORY_MAX_AGE_SECONDS = 90 * 60;

interface TierObservation {
  source: LitestreamTierSource;
  newestMs: number;
  newestTxid: string | null;
}

/**
 * Read one level's LOCAL `ltx/<level>/` directory.
 *
 * Only level 0 is ever populated locally by Litestream 0.5.12 — verified on the live
 * container 2026-08-12, where `/app/data/.app.db-litestream/ltx/` contained exactly one
 * entry, `0`. Higher levels are compacted straight into the remote replica. This function is
 * still tried for every level (it is one cheap `readdir` and costs nothing when the directory
 * is absent) so that a future Litestream release which does cache higher levels locally would
 * be picked up automatically, and so tests can exercise any level from the filesystem.
 */
function observeTierLocally(statePath: string, tier: LitestreamCompactionTier): TierObservation | "missing" | "failed" {
  const dir = join(statePath, "ltx", tier);
  let observation: LocalLtxObservation | null;
  try {
    observation = readLocalLtxDirectory(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    // A missing directory is the normal case for every level but 0 — not a scan failure.
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "failed";
  }
  if (!observation) return "missing";
  return { source: "local-ltx", newestMs: observation.newestMs, newestTxid: observation.newestTxid };
}

function remoteInventoryState(
  inventory: LitestreamRemoteInventorySnapshot | null | undefined,
  nowMs: number,
  maxAgeSeconds: number
): LitestreamRemoteInventoryState {
  if (!inventory) return "missing";
  const collectedAtMs = Date.parse(inventory.collectedAt);
  if (!Number.isFinite(collectedAtMs)) return "stale";
  if ((nowMs - collectedAtMs) / 1000 > maxAgeSeconds) return "stale";
  return inventory.status;
}

/**
 * Per-compaction-level backup freshness, from the two sources that genuinely exist.
 *
 * WHAT THIS CAN AND CANNOT SEE (the whole point of the 2026-08-12 rewrite — the previous
 * version claimed to cover levels 0/1/2/3/9 and in production covered NONE of them):
 *
 *  - **Level 0** is read from the local `ltx/0/` directory. Real-time, free, always available
 *    wherever Litestream runs beside the app.
 *  - **Levels 1/2/3/9** exist ONLY in the remote replica. They are read from an out-of-band
 *    inventory collected on a schedule by src/lib/litestream-remote-inventory.ts (which shells
 *    out to the pinned `litestream ltx -level N -json` binary). That listing costs real
 *    Backblaze B2 requests and up to ~8s for level 1, so it must never run inline in a health
 *    request — this function only ever READS an already-collected snapshot.
 *  - **Litestream's own `compaction failed` log lines** — the most direct evidence of the
 *    2026-08-12 wedge — are NOT obtainable. They go to the container's stdout pipe, which is
 *    owned by the Docker log collector; the app can only reach it by draining the same pipe
 *    and stealing lines from `docker logs`. Not viable, so this monitor infers the wedge from
 *    a level that stops advancing instead.
 *
 * A level with no usable signal reports `state: "not-observable"` with a specific reason,
 * never a bare "unknown".
 *
 * Never throws: a missing state directory, an unreadable path, or an absent inventory all
 * degrade to an explained `not-observable`, so this stays safe to call from any environment
 * (tests, local dev) where Litestream is not running at all.
 */
export function assessLitestreamTierFreshness(
  statePath: string | undefined,
  options: {
    nowMs?: number;
    thresholdsSeconds?: Partial<Record<LitestreamCompactionTier, number>>;
    remoteInventory?: LitestreamRemoteInventorySnapshot | null;
    remoteInventoryMaxAgeSeconds?: number;
  } = {}
): LitestreamTierFreshnessReport {
  const nowMs = options.nowMs ?? Date.now();
  const inventory = options.remoteInventory ?? null;
  const inventoryState = remoteInventoryState(
    inventory,
    nowMs,
    options.remoteInventoryMaxAgeSeconds ?? LITESTREAM_REMOTE_INVENTORY_MAX_AGE_SECONDS
  );
  const inventoryUsable = inventoryState === "ok" || inventoryState === "partial";

  const observations = new Map<LitestreamCompactionTier, TierObservation>();
  const blocked = new Map<LitestreamCompactionTier, { reason: LitestreamTierUnobservableReason; detail: string }>();

  for (const tier of LITESTREAM_COMPACTION_TIERS) {
    const local = statePath ? observeTierLocally(statePath, tier) : "missing";
    if (typeof local === "object") {
      observations.set(tier, local);
      continue;
    }
    if (local === "failed") {
      blocked.set(tier, {
        reason: "local-scan-failed",
        detail: `The local ltx/${tier}/ directory exists but could not be read.  Backup freshness for this level is unknown until that path is readable again.`
      });
      continue;
    }

    // Not present locally: this level lives only in the remote replica.
    if (!inventoryUsable) {
      if (inventoryState === "stale") {
        blocked.set(tier, {
          reason: "remote-inventory-stale",
          detail: `Level ${tier} is stored only in the remote replica, and the scheduled replica inventory is older than ${Math.round((options.remoteInventoryMaxAgeSeconds ?? LITESTREAM_REMOTE_INVENTORY_MAX_AGE_SECONDS) / 60)} minutes.  Its numbers are too old to grade this level, so nothing is claimed about it.`
        });
      } else if (inventoryState === "failed" || inventoryState === "skipped") {
        const why = inventory?.skippedReason?.trim();
        blocked.set(tier, {
          reason: "remote-inventory-failed",
          detail: `Level ${tier} is stored only in the remote replica, and the scheduled replica inventory did not produce data.${why ? `  Reason: ${why}.` : ""}`
        });
      } else {
        blocked.set(tier, {
          reason: !statePath ? "no-state-path" : "remote-inventory-missing",
          detail: !statePath
            ? `No Litestream state directory is configured here, and no replica inventory has been collected, so level ${tier} cannot be observed at all.`
            : `Level ${tier} is stored only in the remote replica (Litestream 0.5.12 keeps no local ltx/${tier}/ directory).  The scheduled replica inventory has not reported yet in this process.`
        });
      }
      continue;
    }

    const remoteError = inventory?.levelErrors?.[tier];
    if (remoteError) {
      blocked.set(tier, {
        reason: "remote-inventory-failed",
        detail: `Listing level ${tier} in the remote replica failed: ${remoteError}.`
      });
      continue;
    }

    const summary = inventory?.levels?.[tier];
    if (!summary) {
      blocked.set(tier, {
        reason: "remote-inventory-missing",
        detail: `Level ${tier} is stored only in the remote replica, and the last inventory did not cover it.`
      });
      continue;
    }

    const newestMs = Date.parse(summary.newestAt);
    if (summary.fileCount <= 0 || !Number.isFinite(newestMs)) {
      blocked.set(tier, {
        reason: "no-activity-recorded",
        detail: `The remote replica holds no LTX files at level ${tier} yet, so there is no activity to measure freshness against.  This is normal for a level Litestream has not needed to produce.`
      });
      continue;
    }
    observations.set(tier, { source: "remote-inventory", newestMs, newestTxid: summary.newestTxid });
  }

  // Level 0 is the pacemaker: every higher level only has work to do because level 0 produced
  // new transactions. Using its newest txid as the reference means an IDLE database (level 0
  // quiet, so nothing to compact) cannot false-alarm every higher level — while a level whose
  // txid has fallen behind a still-advancing level 0, past its threshold, is a real wedge.
  const referenceTxid = observations.get("0")?.newestTxid ?? null;

  const tiers = LITESTREAM_COMPACTION_TIERS.map((tier): LitestreamTierFreshness => {
    const thresholdSeconds = options.thresholdsSeconds?.[tier] ?? LITESTREAM_TIER_STALE_AFTER_SECONDS[tier];
    const label = LITESTREAM_TIER_LABELS[tier];
    const observation = observations.get(tier);
    if (!observation) {
      const block = blocked.get(tier) ?? {
        reason: "remote-inventory-missing" as const,
        detail: `No freshness signal is available for level ${tier}.`
      };
      return { tier, label, state: "not-observable", thresholdSeconds, reason: block.reason, detail: block.detail };
    }

    const ageSeconds = Math.max(0, Math.round((nowMs - observation.newestMs) / 1000));
    const overThreshold = ageSeconds > thresholdSeconds;
    // Level 0 is graded on age alone — it IS the pacemaker, so there is nothing to lag behind.
    const caughtUpWithLevel0 =
      tier !== "0"
      && observation.newestTxid !== null
      && referenceTxid !== null
      && compareLitestreamTxid(observation.newestTxid, referenceTxid) >= 0;

    return {
      tier,
      label,
      state: "known",
      source: observation.source,
      newestActivityAt: new Date(observation.newestMs).toISOString(),
      newestTxid: observation.newestTxid,
      ageSeconds,
      thresholdSeconds,
      degraded: overThreshold && !caughtUpWithLevel0
    };
  });

  return {
    tiers,
    degraded: tiers.some((t) => t.state === "known" && t.degraded),
    observedTiers: tiers.filter((t) => t.state === "known").length,
    notObservableTiers: tiers.filter((t) => t.state === "not-observable").length,
    remoteInventoryState: inventoryState,
    remoteInventoryCollectedAt: inventory?.collectedAt ?? null
  };
}

function fileFallback(statePath: string | undefined, nowMs: number): LitestreamRuntimeHealth | null {
  if (!statePath) return null;
  try {
    const newestMs = newestFileMtimeMs(statePath);
    if (newestMs === null || !(newestMs > 0)) return null;
    return {
      state: "known",
      source: "file",
      // A fresh state artifact proves recent activity, not the daemon's current state.
      status: "activity-observed",
      lastSyncAt: new Date(newestMs).toISOString(),
      ageSeconds: Math.max(0, Math.round((nowMs - newestMs) / 1000)),
      timestampState: "valid"
    };
  } catch {
    return null;
  }
}

function readUnixSocketJson(socketPath: string, timeoutMs: number, maxResponseBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const succeed = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const req = request({ socketPath, path: "/list", method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      let responseBytes = 0;
      let ended = false;
      res.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responseBytes += buffer.length;
        if (responseBytes > maxResponseBytes) {
          const error = new Error(`Litestream IPC response exceeded ${maxResponseBytes} bytes`);
          fail(error);
          res.destroy(error);
          req.destroy(error);
          return;
        }
        chunks.push(buffer);
      });
      res.on("aborted", () => fail(new Error("Litestream IPC response aborted")));
      res.on("error", fail);
      res.on("end", () => {
        ended = true;
        const statusCode = res.statusCode ?? 500;
        if (statusCode < 200 || statusCode >= 300) {
          fail(new Error(`Litestream IPC HTTP ${statusCode}`));
          return;
        }
        try {
          succeed(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          fail(error);
        }
      });
      res.on("close", () => {
        if (!ended && !res.complete) fail(new Error("Litestream IPC response closed before completion"));
      });
    });
    // A wall-clock deadline is required here. ClientRequest#setTimeout() is only an
    // inactivity timer, so a trickling daemon response could otherwise hold /api/health open.
    const timer = setTimeout(
      () => req.destroy(new Error("Litestream IPC deadline exceeded")),
      Math.max(1, timeoutMs)
    );
    req.on("error", fail);
    req.end();
  });
}

/**
 * Read the running Litestream 0.5.x daemon over its local Unix socket. No network or
 * replica mutation occurs. The legacy mtime source remains a fallback for dev/older setups.
 */
export async function getLitestreamRuntimeHealth(options: {
  dbPath: string;
  socketPath?: string;
  statePath?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowFileFallback?: boolean;
  nowMs?: number;
}): Promise<LitestreamRuntimeHealth> {
  const nowMs = options.nowMs ?? Date.now();
  // Candidate control-socket paths, most-explicit first. The last entry is the
  // Litestream 0.5.x DEFAULT control-socket location (<db-dir>/litestream.sock):
  // 0.5.12 ignores the config file's `socket.path` and listens there instead —
  // prod 2026-07-30..08-01 reported litestreamState "unknown" for days while
  // replication was perfectly healthy, purely because the probe only tried the
  // configured /var/run path. Trying both makes the health check correct
  // regardless of which location the running version picked.
  const socketCandidates = [
    options.socketPath?.trim(),
    process.env.LITESTREAM_SOCKET_PATH?.trim(),
    "/var/run/litestream.sock",
    defaultLitestreamSocketPath(options.dbPath),
  ].filter((p): p is string => Boolean(p));
  const seen = new Set<string>();
  for (const socketPath of socketCandidates) {
    if (seen.has(socketPath)) continue;
    seen.add(socketPath);
    try {
      const payload = await readUnixSocketJson(
        socketPath,
        options.timeoutMs ?? 500,
        options.maxResponseBytes ?? LITESTREAM_IPC_MAX_RESPONSE_BYTES
      );
      const parsed = parseLitestreamListPayload(payload, options.dbPath, nowMs);
      if (parsed) return parsed;
    } catch {
      // Try the next candidate, then fall through to the file source.
    }
  }

  const fallback = options.allowFileFallback === false ? null : fileFallback(options.statePath, nowMs);
  return fallback ?? { state: "unknown", source: "none" };
}
