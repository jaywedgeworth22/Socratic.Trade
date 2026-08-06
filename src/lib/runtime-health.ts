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
const LITESTREAM_FILE_SCAN_MAX_ENTRIES = 256;
const LITESTREAM_FILE_SCAN_MAX_DEPTH = 8;
const LITESTREAM_CLOCK_SKEW_MS = 60_000;

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

function newestFileMtimeMs(target: string): number | null {
  const pending: Array<{ path: string; depth: number }> = [{ path: target, depth: 0 }];
  let entries = 0;
  let newestMs = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    entries += 1;
    if (entries > LITESTREAM_FILE_SCAN_MAX_ENTRIES) return null;
    const stat = statSync(current.path);
    if (!stat.isDirectory()) {
      newestMs = Math.max(newestMs, stat.mtimeMs);
      continue;
    }
    if (current.depth >= LITESTREAM_FILE_SCAN_MAX_DEPTH) return null;
    for (const file of readdirSync(current.path)) {
      pending.push({ path: join(current.path, file), depth: current.depth + 1 });
    }
  }
  return newestMs;
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
