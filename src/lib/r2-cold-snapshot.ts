// r2-cold-snapshot.ts — weekly cold snapshot of the production SQLite DB to Cloudflare R2.
//
// Owner directive (2026-08-08): with litestream's active replica moved to Backblaze B2
// (PR #2584), the R2 bucket sits idle — use it intelligently as SECOND-PROVIDER disaster
// recovery. Once a week (Sunday ~03:17 UTC, staggered off the top of the hour), take a
// consistent better-sqlite3 `backup()` of the live DB to a temp file, stream it through
// gzip, and multipart-upload the compressed stream to the historic R2 bucket under
// `cold-snapshots/app-<ISO-date>.db.gz`, then prune to the newest N (default 1) snapshots
// across BOTH extensions (`.db` legacy raw uploads and `.db.gz`).
//
// Gzip (2026-08-31, PR #3135): the raw DB reached ~9.7 GB, putting one uncompressed
// weekly copy at ~90% of the 10 GiB R2 free tier.  The upload now streams the backup
// file through node zlib createGzip into sequential multipart parts — memory stays
// bounded at roughly one part (default 100 MB) plus zlib buffers, never the whole file
// (the box has 16 GB of SHARED RAM).  Expected compressed size ~2.5-4 GB.  No
// compression knob — always gzip.  RESTORE now needs a gunzip step first: download the
// `.db.gz`, `gunzip` it, then treat the result exactly like the old raw `.db` snapshot
// (see docs/litestream.md).
//
// Skip-prune freshen (2026-09-04): a successful Sunday run with retain=1 would upload
// the new `.db.gz` THEN DeleteObject the legacy raw snapshot.  Read-only inventory
// 2026-09-04 (SocraticTrade.com account, bucket `socratic-trade-bucket`):
// object_count=1, bucket_size ~9.68 GB; sole key `cold-snapshots/app-2026-08-30.db`
// size=9679310848 (~9.02 GiB); `trading-live/` empty (0 objects, historic litestream
// prune moot); `weekly/` empty (0 objects, leftover `R2_ARCHIVE_KEEP_GENERATIONS`
// unused).  Jay has NOT approved deleting that 9 GiB object.  Set
// `R2_COLD_SNAPSHOT_SKIP_PRUNE=1` (1/true/on/yes) so the first gzip land uploads
// WITHOUT pruning.  Default remains current retain=1 prune for normal Sunday jobs
// AFTER Jay approves the delete.  Agents must never DeleteObject against this bucket
// without that approval.
//
// Budget stance: stays reliably far under the R2 free tier. One weekly run costs roughly
// 30-45 Class A ops (create + ~25-40 compressed parts at 100 MB + complete + list + up to
// a couple deletes) ≈ 200/month vs the 1M free-tier allowance; storage is
// retain×compressed-size.  Retain is pinned at 1.  The retention pass counts + prunes
// both `.db` and `.db.gz` objects, so the first successful `.gz` upload WITHOUT
// skip-prune would delete the last legacy raw `.db` object.  Host-verified 2026-08-18
// (pre-gzip): `R2_COLD_SNAPSHOT_DEFAULT_RETAIN=1`, `R2_COLD_SNAPSHOT_RETAIN`
// unset, and `cold-snapshots/` holds exactly one object
// (`app-2026-08-16.db`).  `R2_ARCHIVE_KEEP_GENERATIONS` is unused leftover
// (empty `weekly/` prefix) and must not drive this lane.  `R2_COLD_SNAPSHOT_RETAIN`
// values above 1 are ignored so a leftover env cannot leave the free tier.
// Do not delete live R2 objects from agents.  A budget guard refuses
// to run at all when the r2-usage monitor's latest ST snapshot shows month-to-date Class A
// ops above 50% of the free tier. The R2 free-tier kill-switch in r2-usage.ts is untouched
// (it is gated to litestream's endpoint being R2, which it no longer is).
//
// Scheduling: a durable weekly due-job (db-jobs.ts, job_type "r2_cold_snapshot") rather
// than an in-process interval — the snapshot survives process downtime: if the box is down
// over Sunday 03:17 UTC, the pending job is claimed on the next scheduler tick after boot.
// The scheduler tick both (a) ensures the next weekly job exists (idempotent via dedupe
// key) and (b) drains due jobs.
//
// Gating: silently a no-op (with ONE audit row per distinct reason) unless the
// AWS_R2_HISTORIC_* credentials + bucket + endpoint from PR #2584 are configured.
// R2_COLD_SNAPSHOT_ENABLED=0/off/false/no is the explicit kill switch.
// R2_COLD_SNAPSHOT_SKIP_PRUNE=1/true/on/yes is the opt-in freshen gate (default off).
//
// Snapshot mechanism (2026-09-08, CLAUDE): `VACUUM INTO` in a short-lived CHILD PROCESS,
// NOT better-sqlite3 `backup()`.  Root cause of the 9-day archive stall: SQLite's online
// backup API restarts from page 1 whenever the source DB is modified through a DIFFERENT
// connection (sqlite3_backup_step -> SQLITE_BUSY/restart).  app.db is written continuously
// by the live trading app AND checkpointed by litestream, so on a ~10.7 GB DB the copy can
// never outrun the writers.  Production evidence 2026-09-08: the temp backup file sat at
// exactly 5666406400 bytes across three samples 8 minutes apart while its mtime advanced
// every few seconds, and `week-2026-09-06` reached attempts=27 with `last_error` NULL and
// ZERO `r2_cold_snapshot.error`/`.success` audit rows — it hung, it never failed.  Locally
// reproduced on better-sqlite3 13.0.3 (the production version): 2698 restarts in 15s with
// remainingPages pinned at 10601/10701.  `VACUUM INTO` runs inside ONE read transaction, so
// concurrent writers cannot restart it; it also emits a COMPACTED copy (smaller upload).  It
// is synchronous and would block the event loop for minutes, so it runs in a child process
// spawned with a MINIMAL env (no secrets) and is killed at the deadline below.
//
// Deadline: every snapshot attempt is bounded by R2_COLD_SNAPSHOT_DEADLINE_MIN (default 45,
// well under the 2h job lease) so a stuck snapshot FAILS LOUDLY instead of hanging until the
// lease expires and the next drain silently restarts it.  Bounding the attempt below the
// lease also stops overlapping attempts from piling up inside one process lifetime (each
// attempt's start-of-run sweep unlinks the previous attempt's temp file while that attempt
// still holds the fd — invisible multi-GB disk usage).
//
// Failure: audited, surfaced once via the existing storage_warning notification path
// (db-health.ts alertStorageWarning — 12h per-warning-type cooldown) AND as a Sentry
// structured log, then retried with due-job backoff. Never throws into the scheduler tick.
//
// Freshness watchdog: `reportR2WeeklyFreshness()` (called from the scheduler lane) watches
// the SAME `checks.storage.r2Weekly` state the public health endpoint publishes and emits
// ONE Sentry event per state TRANSITION (ok <-> archive_stale/archive_not_run), persisted in
// an internal setting.  Before this, nothing watched that field: the archive went stale on
// 2026-09-06 and was still silent 9 days later.

// Bare "fs"/"os"/"path" (not the "node:" scheme) so Next.js webpack can externalize this
// module for server bundles — same trap as r2-usage.ts / egress-guard.
import { spawn } from "child_process";
import crypto from "crypto";
import { createReadStream, existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { createGzip } from "zlib";
import { audit, databasePath } from "./db";
import { getInternalSetting, setInternalSetting } from "./db-settings";
import {
  claimDueJobs,
  completeDueJob,
  enqueueDueJob,
  failDueJob,
  getDueJobStats,
} from "./db-jobs";
import { getR2UsageSnapshots, R2_FREE_TIER } from "./r2-usage";
import { logError, logWarn } from "./sentry-metrics";

// ── Constants ────────────────────────────────────────────────────────────────

export const R2_COLD_SNAPSHOT_JOB_TYPE = "r2_cold_snapshot";
export const R2_COLD_SNAPSHOT_PREFIX = "cold-snapshots/";
/** Weekly slot: Sunday, 03:17 UTC (staggered off the top of the hour so it never
 *  stampedes with other fleet crons that fire at :00). */
export const R2_COLD_SNAPSHOT_UTC_DAY = 0; // Sunday
export const R2_COLD_SNAPSHOT_UTC_HOUR = 3;
export const R2_COLD_SNAPSHOT_UTC_MINUTE = 17;
/** Host-verified weekly retain (2026-08-18): default 1, env unset, one object. */
export const R2_COLD_SNAPSHOT_DEFAULT_RETAIN = 1;
export const R2_COLD_SNAPSHOT_DEFAULT_PART_BYTES = 100 * 1024 * 1024; // 100 MB parts
/** S3 floor for every part except the last. */
export const R2_COLD_SNAPSHOT_MIN_PART_BYTES = 5 * 1024 * 1024;
/** Refuse to run when the ST account's month-to-date Class A ops exceed this share
 *  of the free tier (read from the r2-usage monitor's persisted snapshot). */
export const R2_COLD_SNAPSHOT_BUDGET_GUARD_PCT = 50;

/** Hard bound on ONE snapshot attempt (the step that hung for 9 days).  Must stay well
 *  under the 2h due-job lease so an attempt can never outlive its own claim. */
export const R2_COLD_SNAPSHOT_DEFAULT_DEADLINE_MS = 45 * 60_000;

const DISABLED_AUDIT_KEY = "r2coldsnap:disabledAuditedReason";
/** Last `checks.storage.r2Weekly` state reported to Sentry — transitions only, not ticks. */
export const R2_COLD_SNAPSHOT_HEALTH_STATE_KEY = "r2coldsnap:lastHealthState";
/** Persisted after every successful weekly upload — health reads this, never R2. */
export const R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY = "r2coldsnap:lastSuccess";
/** Last failure (observability only; does not alone fail health). */
export const R2_COLD_SNAPSHOT_LAST_FAILURE_KEY = "r2coldsnap:lastFailure";
/**
 * Max age of the last successful cold snapshot for `checks.storage.r2Weekly.ok`.
 * Matches Usage Monitor `R2_ARCHIVE_MAX_AGE_SECONDS` (weekly job + one-day slack).
 */
export const R2_ARCHIVE_MAX_AGE_SECONDS = 8 * 24 * 3600;
/** Matches both the current gzipped uploads and legacy raw `.db` uploads so the
 *  retention pass counts + prunes across both extensions (retain=1 semantics). */
const KEY_PATTERN = /^cold-snapshots\/app-\d{4}-\d{2}-\d{2}\.db(\.gz)?$/;

export interface R2ColdSnapshotLastSuccess {
  key: string;
  completedAt: string;
  /** Uploaded object size (gzip-compressed as of 2026-08-31). */
  bytes: number;
  /** Uncompressed backup size (absent on receipts written before gzip landed). */
  rawBytes?: number;
}

export interface R2ColdSnapshotLastFailure {
  key: string | null;
  failedAt: string;
  reason: string;
}

/**
 * Public-safe shape for `checks.storage.r2Weekly` on GET /api/health.
 * No credentials, bucket names, or endpoints — object key + age only.
 */
export interface R2WeeklyHealthStatus {
  ok: boolean;
  ageSeconds: number | null;
  key: string | null;
  reason: "archive_stale" | "archive_not_run" | null;
}

/**
 * Cheap local reader for the weekly R2 cold-snapshot lane. Reads only the
 * internal setting written on success — never performs S3/R2 network I/O.
 * `ok` is true when the last success is within {@link R2_ARCHIVE_MAX_AGE_SECONDS}
 * (8 days). A failed week does not flip `ok` false while the prior success is
 * still inside that window (observability only; not folded into storageDegraded).
 */
export function getR2WeeklyHealthStatus(nowMs: number = Date.now()): R2WeeklyHealthStatus {
  try {
    const last = getInternalSetting<R2ColdSnapshotLastSuccess>(R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY);
    if (!last || typeof last.key !== "string" || !last.key || typeof last.completedAt !== "string") {
      return { ok: false, ageSeconds: null, key: null, reason: "archive_not_run" };
    }
    const completedMs = Date.parse(last.completedAt);
    if (!Number.isFinite(completedMs)) {
      return { ok: false, ageSeconds: null, key: null, reason: "archive_not_run" };
    }
    const ageSeconds = Math.max(0, Math.floor((nowMs - completedMs) / 1000));
    if (ageSeconds > R2_ARCHIVE_MAX_AGE_SECONDS) {
      return { ok: false, ageSeconds, key: last.key, reason: "archive_stale" };
    }
    return { ok: true, ageSeconds, key: last.key, reason: null };
  } catch {
    return { ok: false, ageSeconds: null, key: null, reason: "archive_not_run" };
  }
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface R2ColdSnapshotConfig {
  enabled: boolean;
  /** Why the lane is off (only when !enabled). */
  disabledReason?: "kill_switch" | "missing_credentials";
  bucket: string;
  /** Endpoint host, protocol stripped (e.g. <account>.r2.cloudflarestorage.com). */
  host: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  retain: number;
  partSizeBytes: number;
  /**
   * Opt-in: upload the new `.db.gz` but do not DeleteObject older snapshots.
   * Default false (retain=1 prune).  First gzip land must set
   * `R2_COLD_SNAPSHOT_SKIP_PRUNE=1` until Jay approves deleting
   * `cold-snapshots/app-2026-08-30.db`.
   */
  skipPrune: boolean;
  /** Hard bound on the snapshot step, from `R2_COLD_SNAPSHOT_DEADLINE_MIN`. */
  snapshotDeadlineMs: number;
}

/**
 * Env names follow PR #2584's convention: the R2 credentials preserved when litestream's
 * active replica moved to B2 live as AWS_R2_HISTORIC_* (Infisical + .env.example).
 * Default ON only when the full credential set exists; R2_COLD_SNAPSHOT_ENABLED is the
 * explicit kill switch (off/false/0/no).
 * Weekly retain reads only `R2_COLD_SNAPSHOT_RETAIN` (unset in prod → default 1).
 * `R2_ARCHIVE_KEEP_GENERATIONS` is unused leftover and is not consulted.
 * `R2_COLD_SNAPSHOT_SKIP_PRUNE` is opt-in (1/true/on/yes); default is prune.
 */
export function r2ColdSnapshotSkipPruneFromEnv(
  raw: string | undefined = process.env.R2_COLD_SNAPSHOT_SKIP_PRUNE,
): boolean {
  const v = raw?.trim().toLowerCase() ?? "";
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function loadR2ColdSnapshotConfig(): R2ColdSnapshotConfig {
  const bucket = process.env.AWS_R2_HISTORIC_BUCKET_NAME?.trim() ?? "";
  const endpoint = process.env.AWS_R2_HISTORIC_ENDPOINT?.trim() ?? "";
  const region = process.env.AWS_R2_HISTORIC_REGION?.trim() || "auto";
  const accessKeyId = process.env.AWS_R2_HISTORIC_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = process.env.AWS_R2_HISTORIC_SECRET_ACCESS_KEY?.trim() ?? "";
  const retainRaw = Number(process.env.R2_COLD_SNAPSHOT_RETAIN ?? "");
  const requestedRetain =
    Number.isFinite(retainRaw) && retainRaw >= 1 ? Math.floor(retainRaw) : R2_COLD_SNAPSHOT_DEFAULT_RETAIN;
  // Free-tier cap: one weekly snapshot.  Env may request more; we never keep more than 1.
  const retain = Math.min(requestedRetain, R2_COLD_SNAPSHOT_DEFAULT_RETAIN);
  const partMbRaw = Number(process.env.R2_COLD_SNAPSHOT_PART_MB ?? "");
  const partSizeBytes =
    Number.isFinite(partMbRaw) && partMbRaw * 1024 * 1024 >= R2_COLD_SNAPSHOT_MIN_PART_BYTES
      ? Math.floor(partMbRaw * 1024 * 1024)
      : R2_COLD_SNAPSHOT_DEFAULT_PART_BYTES;

  const deadlineMinRaw = Number(process.env.R2_COLD_SNAPSHOT_DEADLINE_MIN ?? "");
  const snapshotDeadlineMs =
    Number.isFinite(deadlineMinRaw) && deadlineMinRaw > 0
      ? Math.floor(deadlineMinRaw * 60_000)
      : R2_COLD_SNAPSHOT_DEFAULT_DEADLINE_MS;

  const killRaw = process.env.R2_COLD_SNAPSHOT_ENABLED?.trim().toLowerCase();
  const killed = killRaw === "0" || killRaw === "off" || killRaw === "false" || killRaw === "no";
  const hasCreds = Boolean(bucket && endpoint && accessKeyId && secretAccessKey);
  const skipPrune = r2ColdSnapshotSkipPruneFromEnv();

  return {
    enabled: hasCreds && !killed,
    disabledReason: killed ? "kill_switch" : hasCreds ? undefined : "missing_credentials",
    bucket,
    host: endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    region,
    accessKeyId,
    secretAccessKey,
    retain,
    partSizeBytes,
    skipPrune,
    snapshotDeadlineMs,
  };
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** Next Sunday 03:17 UTC strictly after `nowMs`, plus the per-week dedupe key. */
export function nextR2ColdSnapshotDueAt(nowMs: number): { dueAtISO: string; dedupeKey: string } {
  const now = new Date(nowMs);
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    R2_COLD_SNAPSHOT_UTC_HOUR,
    R2_COLD_SNAPSHOT_UTC_MINUTE,
    0,
    0,
  ));
  const daysUntilSunday = (R2_COLD_SNAPSHOT_UTC_DAY - candidate.getUTCDay() + 7) % 7;
  candidate.setUTCDate(candidate.getUTCDate() + daysUntilSunday);
  if (candidate.getTime() <= nowMs) candidate.setUTCDate(candidate.getUTCDate() + 7);
  const dueAtISO = candidate.toISOString();
  return { dueAtISO, dedupeKey: `week-${dueAtISO.slice(0, 10)}` };
}

/**
 * Retention: given a bucket listing, return the cold-snapshot keys to DELETE so only the
 * newest `retain` remain. Counts BOTH extensions: only keys matching our exact
 * `cold-snapshots/app-YYYY-MM-DD.db` or `...db.gz` pattern are ever candidates — historic
 * litestream objects (different prefix/shape) can never be pruned by this lane. Snapshot
 * keys embed the ISO date, so lexical sort == chronological sort (a same-date `.db.gz`
 * sorts after its `.db` twin, i.e. the gzipped upload is treated as newer). This is what
 * prunes the last legacy raw `.db` object after the first successful `.gz` upload. Pure.
 */
export function selectColdSnapshotsToPrune(keys: readonly string[], retain: number): string[] {
  const snapshots = keys.filter((k) => KEY_PATTERN.test(k)).sort().reverse();
  return snapshots.slice(Math.max(1, retain));
}

/** The r2-usage monitor's latest month-to-date Class A percentage for the Socratic
 *  Trade account, or null when the monitor has no snapshot (guard then defers). */
export function r2ColdSnapshotClassAPct(): number | null {
  try {
    const snaps = getR2UsageSnapshots();
    const st = snaps.find((s) => s.accountLabel === "Socratic Trade") ?? (snaps.length === 1 ? snaps[0] : undefined);
    const classA = st?.metrics.find((m) => m.id === "classA");
    return classA && Number.isFinite(classA.pctUsed) ? classA.pctUsed : null;
  } catch {
    return null;
  }
}

// ── Minimal S3 SigV4 (modeled on market-signals/massive-s3.ts, extended with
//    query strings + request bodies for multipart/list/delete) ────────────────

const sha256hex = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key: crypto.BinaryLike, s: string): Buffer => crypto.createHmac("sha256", key).update(s).digest();

export interface R2ColdSnapshotDeps {
  fetchImpl?: typeof fetch;
  /**
   * Test seam for the consistent-snapshot step.  Default: `VACUUM INTO` in a child
   * process (see {@link runVacuumIntoSnapshot}) — NOT better-sqlite3 `backup()`, which
   * cannot converge against a concurrently written DB.
   */
  backupImpl?: (destPath: string) => Promise<unknown>;
  /** Test seam for the per-attempt snapshot deadline (production uses config). */
  snapshotDeadlineMs?: number;
  /** Test seam for the storage_warning advisory (db-health.alertStorageWarning). */
  alertImpl?: (warningType: string, message: string) => Promise<void>;
  /** Test seam for small multipart parts (production uses config partSizeBytes). */
  partSizeBytes?: number;
}

interface S3Response {
  status: number;
  ok: boolean;
  etag: string | null;
  body: string;
}

async function s3Request(
  cfg: R2ColdSnapshotConfig,
  method: string,
  key: string | null,
  query: Record<string, string>,
  body: Buffer | null,
  deps: R2ColdSnapshotDeps,
  timeoutMs: number,
): Promise<S3Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const segments = key === null ? [cfg.bucket] : [cfg.bucket, ...key.split("/")];
  const canonicalUri = "/" + segments.map(encodeURIComponent).join("/");
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join("&");
  const payloadHash = sha256hex(body ?? "");
  const canonicalHeaders = `host:${cfg.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac("AWS4" + cfg.secretAccessKey, dateStamp), cfg.region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `https://${cfg.host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Authorization: authorization,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
      },
      // Uint8Array view keeps undici happy across Node Buffer/BodyInit typings.
      body: body ? new Uint8Array(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, etag: res.headers.get("etag"), body: text };
  } finally {
    clearTimeout(timeout);
  }
}

const CONTROL_TIMEOUT_MS = 60_000;
const PART_TIMEOUT_MS = 15 * 60_000; // 100 MB per part on a modest uplink

async function createMultipartUpload(cfg: R2ColdSnapshotConfig, key: string, deps: R2ColdSnapshotDeps): Promise<string> {
  const res = await s3Request(cfg, "POST", key, { uploads: "" }, null, deps, CONTROL_TIMEOUT_MS);
  if (!res.ok) throw new Error(`CreateMultipartUpload HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(res.body)?.[1];
  if (!uploadId) throw new Error("CreateMultipartUpload: no UploadId in response");
  return uploadId;
}

async function uploadPart(
  cfg: R2ColdSnapshotConfig,
  key: string,
  uploadId: string,
  partNumber: number,
  body: Buffer,
  deps: R2ColdSnapshotDeps,
): Promise<string> {
  const res = await s3Request(
    cfg,
    "PUT",
    key,
    { partNumber: String(partNumber), uploadId },
    body,
    deps,
    PART_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`UploadPart ${partNumber} HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  const etag = res.etag;
  if (!etag) throw new Error(`UploadPart ${partNumber}: no ETag in response`);
  return etag;
}

async function completeMultipartUpload(
  cfg: R2ColdSnapshotConfig,
  key: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>,
  deps: R2ColdSnapshotDeps,
): Promise<void> {
  const xml =
    `<CompleteMultipartUpload>` +
    parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`).join("") +
    `</CompleteMultipartUpload>`;
  const res = await s3Request(cfg, "POST", key, { uploadId }, Buffer.from(xml, "utf8"), deps, CONTROL_TIMEOUT_MS);
  // S3 can return 200 with an <Error> body on complete — treat that as failure too.
  if (!res.ok || res.body.includes("<Error>")) {
    throw new Error(`CompleteMultipartUpload HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
}

async function abortMultipartUpload(cfg: R2ColdSnapshotConfig, key: string, uploadId: string, deps: R2ColdSnapshotDeps): Promise<void> {
  try {
    await s3Request(cfg, "DELETE", key, { uploadId }, null, deps, CONTROL_TIMEOUT_MS);
  } catch {
    // best-effort — an orphaned multipart upload is invisible storage; R2 reaps them.
  }
}

/**
 * Stream the temp backup file through gzip into sequential multipart parts.
 * Memory stays bounded at roughly ONE part (default 100 MB) plus zlib buffers —
 * the ~10 GB raw backup is never buffered in full, and awaiting each part upload
 * pauses the gzip stream (async-iterator backpressure) so compressed output can
 * never pile up faster than it is shipped.
 */
async function uploadGzippedParts(
  cfg: R2ColdSnapshotConfig,
  key: string,
  uploadId: string,
  srcPath: string,
  partSizeBytes: number,
  deps: R2ColdSnapshotDeps,
): Promise<{ completedParts: Array<{ partNumber: number; etag: string }>; compressedBytes: number }> {
  const completedParts: Array<{ partNumber: number; etag: string }> = [];
  let compressedBytes = 0;
  let partNumber = 1;
  let pending: Buffer[] = [];
  let pendingBytes = 0;

  const flush = async (body: Buffer): Promise<void> => {
    const etag = await uploadPart(cfg, key, uploadId, partNumber, body, deps);
    completedParts.push({ partNumber, etag });
    partNumber += 1;
  };

  const gzip = createGzip();
  const source = createReadStream(srcPath, { highWaterMark: 4 * 1024 * 1024 });
  // pipe() does not forward source errors to its destination — destroy the gzip
  // stream ourselves so the for-await below rejects instead of hanging forever.
  source.on("error", (err) => gzip.destroy(err));
  source.pipe(gzip);

  try {
    for await (const chunk of gzip as AsyncIterable<Buffer>) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      compressedBytes += chunk.length;
      while (pendingBytes >= partSizeBytes) {
        const joined = pending.length === 1 ? pending[0] : Buffer.concat(pending);
        await flush(joined.subarray(0, partSizeBytes));
        const rest = joined.subarray(partSizeBytes);
        pending = rest.length > 0 ? [rest] : [];
        pendingBytes = rest.length;
      }
    }
    // Final (possibly short — S3 allows any size for the LAST part) flush.  gzip
    // output is never zero bytes for any input, but keep the single-empty-part
    // fallback so a pathological case still completes rather than erroring.
    if (pendingBytes > 0 || completedParts.length === 0) {
      await flush(pending.length === 1 ? pending[0] : Buffer.concat(pending));
    }
    return { completedParts, compressedBytes };
  } finally {
    // A thrown flush() exits the for-await early — destroy both streams so the
    // backup file's fd cannot leak while the failed run is being cleaned up.
    source.destroy();
    gzip.destroy();
  }
}

async function listColdSnapshotKeys(cfg: R2ColdSnapshotConfig, deps: R2ColdSnapshotDeps): Promise<string[]> {
  const keys: string[] = [];
  let continuation: string | undefined;
  for (let page = 0; page < 8; page++) {
    const query: Record<string, string> = { "list-type": "2", prefix: R2_COLD_SNAPSHOT_PREFIX };
    if (continuation) query["continuation-token"] = continuation;
    const res = await s3Request(cfg, "GET", null, query, null, deps, CONTROL_TIMEOUT_MS);
    if (!res.ok) throw new Error(`ListObjectsV2 HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    for (const m of res.body.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(res.body)) break;
    continuation = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(res.body)?.[1];
    if (!continuation) break;
  }
  return keys;
}

async function deleteObject(cfg: R2ColdSnapshotConfig, key: string, deps: R2ColdSnapshotDeps): Promise<void> {
  const res = await s3Request(cfg, "DELETE", key, {}, null, deps, CONTROL_TIMEOUT_MS);
  if (!res.ok && res.status !== 404) throw new Error(`DeleteObject ${key} HTTP ${res.status}`);
}

// ── Consistent snapshot: VACUUM INTO in a child process ──────────────────────

/**
 * Child-process source for the snapshot step.  Runs standalone under `node -e`, so it
 * must not close over anything here and must resolve better-sqlite3 itself.
 *
 * Why a child process: `VACUUM INTO` is a single synchronous statement that takes
 * minutes on a ~10 GB DB.  In-process it would block the event loop, stall
 * `GET /api/health`, and risk a Coolify healthcheck restart mid-snapshot.  A child also
 * gives a real kill switch for the deadline — an in-process hang cannot be cancelled,
 * which is exactly how this lane stayed stuck for 9 days.
 *
 * The source connection is READ-ONLY, so the child can never mutate live trading state.
 * It is spawned with a MINIMAL env: no Infisical secrets are handed to it.
 */
const VACUUM_INTO_CHILD_SOURCE = `
const { createRequire } = require("module");
const src = process.env.R2SNAP_SRC;
const dest = process.env.R2SNAP_DEST;
const base = process.env.R2SNAP_REQUIRE_BASE;
if (!src || !dest) { console.error("R2SNAP_SRC/R2SNAP_DEST required"); process.exit(2); }
let Database;
try { Database = createRequire(base)("better-sqlite3"); }
catch { Database = require("better-sqlite3"); }
const db = new Database(src, { readonly: true, fileMustExist: true });
try {
  db.pragma("busy_timeout = 60000");
  // VACUUM INTO runs inside ONE read transaction: concurrent writers cannot restart it
  // (unlike sqlite3_backup_step), and the output is a compacted, consistent copy.
  db.prepare("VACUUM INTO ?").run(dest);
} finally {
  try { db.close(); } catch {}
}
`;

/**
 * Take a consistent, compacted copy of the live DB at `destPath` using `VACUUM INTO`
 * inside a child process, killed at `deadlineMs`.  Rejects (never hangs) on child
 * failure, non-zero exit, or deadline.
 */
export async function runVacuumIntoSnapshot(
  srcPath: string,
  destPath: string,
  deadlineMs: number = R2_COLD_SNAPSHOT_DEFAULT_DEADLINE_MS,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(process.execPath, ["-e", VACUUM_INTO_CHILD_SOURCE], {
      // Minimal env on purpose — the snapshot child needs no application secrets.
      env: {
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH ?? "",
        R2SNAP_SRC: srcPath,
        R2SNAP_DEST: destPath,
        R2SNAP_REQUIRE_BASE: `${process.cwd()}/`,
      },
      stdio: ["ignore", "ignore", "pipe"] as const,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 2000) stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, deadlineMs);
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    child.on("error", (err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) {
        finish(new Error(`snapshot_deadline_exceeded after ${Math.round(deadlineMs / 1000)}s (VACUUM INTO killed)`));
        return;
      }
      if (code === 0) { finish(); return; }
      finish(new Error(`VACUUM INTO child exited code=${code} signal=${signal ?? "none"}: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

/**
 * Bound ANY snapshot implementation by the deadline.  The child-process default is
 * genuinely cancelled; a `deps.backupImpl` seam that ignores cancellation at least stops
 * blocking the run, so the attempt fails loudly inside its own lease instead of hanging.
 */
export async function withSnapshotDeadline<T>(
  work: () => Promise<T>,
  deadlineMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`snapshot_deadline_exceeded after ${Math.round(deadlineMs / 1000)}s`)),
          deadlineMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── The snapshot itself ──────────────────────────────────────────────────────

export interface R2ColdSnapshotRunResult {
  status: "ok" | "skipped" | "error";
  reason?: string;
  key?: string;
  /** Uploaded (gzip-compressed) object size. */
  bytes?: number;
  /** Uncompressed backup size. */
  rawBytes?: number;
  parts?: number;
  /** Keys actually DeleteObject'd.  Empty when skipPrune is on. */
  pruned?: string[];
  /** Keys retain=1 would delete.  Recorded even when skipPrune leaves them in place. */
  wouldPrune?: string[];
  skipPrune?: boolean;
  durationMs?: number;
}

/** One audit row per distinct disabled-reason (not one per tick) — the "silent
 *  no-op with one audit row" contract. */
function recordDisabledOnce(reason: string): void {
  try {
    if (getInternalSetting<string>(DISABLED_AUDIT_KEY) === reason) return;
    setInternalSetting(DISABLED_AUDIT_KEY, reason);
    audit("r2_cold_snapshot.disabled", { reason });
  } catch {
    // never throw into the scheduler tick
  }
}

async function defaultAlert(warningType: string, message: string): Promise<void> {
  const { alertStorageWarning } = await import("./db-health");
  await alertStorageWarning(warningType, message);
}

/**
 * Take the snapshot and upload it. Never throws — every failure path returns
 * `{ status: "error" }` after auditing + a (12h-deduped) storage_warning advisory.
 */
export async function performR2ColdSnapshot(
  now: number = Date.now(),
  deps: R2ColdSnapshotDeps = {},
): Promise<R2ColdSnapshotRunResult> {
  const cfg = loadR2ColdSnapshotConfig();
  if (!cfg.enabled) {
    recordDisabledOnce(cfg.disabledReason ?? "missing_credentials");
    return { status: "skipped", reason: cfg.disabledReason ?? "missing_credentials" };
  }

  const alert = deps.alertImpl ?? defaultAlert;

  // Budget guard: the weekly upload is ~30-45 Class A ops, but if the month's Class A count
  // is already past 50% of the free tier something ELSE is burning ops — do not add to it.
  const classAPct = r2ColdSnapshotClassAPct();
  if (classAPct !== null && classAPct >= R2_COLD_SNAPSHOT_BUDGET_GUARD_PCT) {
    audit("r2_cold_snapshot.budget_refused", {
      classAPct: Number(classAPct.toFixed(2)),
      guardPct: R2_COLD_SNAPSHOT_BUDGET_GUARD_PCT,
      freeTierClassA: R2_FREE_TIER.classAOps,
    });
    try {
      await alert(
        "r2_cold_snapshot_budget",
        `Weekly R2 cold snapshot skipped: Class A operations are at ${classAPct.toFixed(1)}% ` +
          `of the free tier this month (guard: ${R2_COLD_SNAPSHOT_BUDGET_GUARD_PCT}%). ` +
          `It will retry next week; investigate what is burning R2 Class A ops.`,
      );
    } catch {
      /* advisory only */
    }
    return { status: "skipped", reason: "budget", durationMs: 0 };
  }

  const startedAt = Date.now();
  const isoDate = new Date(now).toISOString().slice(0, 10);
  const key = `${R2_COLD_SNAPSHOT_PREFIX}app-${isoDate}.db.gz`;
  const dbDir = dirname(databasePath());

  // Proactive cleanup: sweep any stale temp snapshot files from crashed or aborted prior runs
  try {
    for (const file of readdirSync(dbDir)) {
      if (file.startsWith(".r2snap-") && (file.endsWith(".tmp") || file.endsWith(".tmp-journal") || file.endsWith(".tmp-wal"))) {
        try { unlinkSync(join(dbDir, file)); } catch { /* ignore */ }
      }
    }
  } catch {
    /* non-fatal; continue with snapshot */
  }

  // Snapshot lands beside the live DB on the persistent volume (same filesystem —
  // no cross-device copy, guaranteed writable) rather than the OS temp dir: the
  // edge-flavored instrumentation webpack pass cannot resolve the "os" builtin.
  const tempPath = join(dbDir, `.r2snap-${crypto.randomUUID()}.db.tmp`);
  const partSizeBytes = deps.partSizeBytes ?? cfg.partSizeBytes;
  let uploadId: string | undefined;

  try {
    audit("r2_cold_snapshot.start", { key, tempPath, partSizeBytes });

    // Consistent snapshot — NEVER a raw copy of the live WAL-mode file, and NEVER
    // better-sqlite3 `backup()`: the online-backup API restarts from page 1 on every
    // write from another connection, so on this ~10.7 GB continuously-written DB it
    // never converges (see the header note; production hung 27 attempts this way).
    // `VACUUM INTO` in a child process takes ONE read snapshot and cannot be restarted.
    const snapshotDeadlineMs = deps.snapshotDeadlineMs ?? cfg.snapshotDeadlineMs;
    const snapshotStartedAt = Date.now();
    const backupImpl =
      deps.backupImpl ?? ((dest: string) => runVacuumIntoSnapshot(databasePath(), dest, snapshotDeadlineMs));
    await withSnapshotDeadline(() => Promise.resolve(backupImpl(tempPath)), snapshotDeadlineMs);
    const snapshotMs = Date.now() - snapshotStartedAt;
    const rawBytes = statSync(tempPath).size;

    uploadId = await createMultipartUpload(cfg, key, deps);
    const { completedParts, compressedBytes } = await uploadGzippedParts(
      cfg,
      key,
      uploadId,
      tempPath,
      partSizeBytes,
      deps,
    );
    await completeMultipartUpload(cfg, key, uploadId, completedParts, deps);
    uploadId = undefined; // completed — nothing to abort from here on

    // Retention: keep the newest `retain` snapshots, delete the rest — unless
    // skipPrune is on (first gzip land: do not delete the legacy 9 GiB `.db`
    // until Jay approves).  A prune failure does not fail the run — the snapshot
    // IS uploaded; next week's prune catches up.
    let pruned: string[] = [];
    let wouldPrune: string[] = [];
    try {
      const keys = await listColdSnapshotKeys(cfg, deps);
      wouldPrune = selectColdSnapshotsToPrune(keys, cfg.retain);
      if (cfg.skipPrune) {
        audit("r2_cold_snapshot.prune_skipped", {
          key,
          wouldPrune,
          reason: "R2_COLD_SNAPSHOT_SKIP_PRUNE",
        });
      } else {
        pruned = wouldPrune;
        for (const k of pruned) await deleteObject(cfg, k, deps);
      }
    } catch (err) {
      audit("r2_cold_snapshot.prune_error", { key, error: err instanceof Error ? err.message : String(err) });
      pruned = [];
      wouldPrune = [];
    }

    const durationMs = Date.now() - startedAt;
    const completedAt = new Date().toISOString();
    try {
      setInternalSetting(R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY, {
        key,
        completedAt,
        bytes: compressedBytes,
        rawBytes,
      } satisfies R2ColdSnapshotLastSuccess);
    } catch {
      /* health may lag until next success; never throw into the scheduler tick */
    }
    audit("r2_cold_snapshot.success", {
      key,
      bytes: compressedBytes,
      rawBytes,
      snapshotMs,
      parts: completedParts.length,
      pruned,
      wouldPrune,
      skipPrune: cfg.skipPrune,
      retain: cfg.retain,
      durationMs,
    });
    return {
      status: "ok",
      key,
      bytes: compressedBytes,
      rawBytes,
      parts: completedParts.length,
      pruned,
      wouldPrune,
      skipPrune: cfg.skipPrune,
      durationMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (uploadId) await abortMultipartUpload(cfg, key, uploadId, deps);
    try {
      setInternalSetting(R2_COLD_SNAPSHOT_LAST_FAILURE_KEY, {
        key,
        failedAt: new Date().toISOString(),
        reason: message.slice(0, 500),
      } satisfies R2ColdSnapshotLastFailure);
    } catch {
      /* never throw */
    }
    try {
      audit("r2_cold_snapshot.error", { key, error: message, durationMs: Date.now() - startedAt });
    } catch {
      /* never throw */
    }
    // Sentry: a failed run is visible immediately, not only once the 8-day staleness
    // window trips.  Bounded by the due-job backoff (max 5 attempts/week), so cheap.
    logError("r2 cold snapshot run failed", { key, reason: message.slice(0, 300) });
    try {
      await alert(
        "r2_cold_snapshot_failed",
        `Weekly R2 cold snapshot failed for ${key}: ${message}. ` +
          `The due-job retries with backoff; B2 litestream replication is unaffected.`,
      );
    } catch {
      /* advisory only */
    }
    return { status: "error", reason: message, durationMs: Date.now() - startedAt };
  } finally {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
      const journal = `${tempPath}-journal`;
      if (existsSync(journal)) unlinkSync(journal);
      const wal = `${tempPath}-wal`;
      if (existsSync(wal)) unlinkSync(wal);
    } catch {
      /* temp-dir janitor sweeps agentic-* leftovers as the backstop */
    }
  }
}

// ── Due-job scheduling + drain (scheduler wiring) ────────────────────────────

/**
 * Idempotently make sure the next weekly job exists. One row per week via the
 * `week-YYYY-MM-DD` dedupe key (INSERT OR IGNORE in enqueueDueJob). Silent no-op
 * (single audit row) when the lane is not configured. Returns true only when a
 * new row was inserted.
 */
export function ensureR2ColdSnapshotJobScheduled(now: number = Date.now()): boolean {
  try {
    const cfg = loadR2ColdSnapshotConfig();
    if (!cfg.enabled) {
      recordDisabledOnce(cfg.disabledReason ?? "missing_credentials");
      return false;
    }
    const { dueAtISO, dedupeKey } = nextR2ColdSnapshotDueAt(now);
    return enqueueDueJob({ jobType: R2_COLD_SNAPSHOT_JOB_TYPE, dedupeKey, dueAt: dueAtISO });
  } catch (err) {
    console.error("[r2-cold-snapshot] schedule error:", err);
    return false;
  }
}

export interface R2ColdSnapshotDrainResult {
  drained: number;
  lastRun?: R2ColdSnapshotRunResult;
}

/**
 * Claim and run due cold-snapshot jobs (limit 1 — there is never more than one
 * meaningful snapshot per drain). Success/skip completes the job; an error fails it
 * back to pending with backoff (db-jobs default: 10 min, max 5 attempts, then
 * terminally unresolvable — next week's job arrives regardless). Never throws.
 */
export async function drainR2ColdSnapshotJobs(
  now: number = Date.now(),
  deps: R2ColdSnapshotDeps = {},
): Promise<R2ColdSnapshotDrainResult> {
  // Unique claimant PER INVOCATION (not just per PID): completeDueJob/failDueJob
  // fence on `claimed_by = claimant`, so if a lease ever expires mid-upload and a
  // later drain reclaims the job, the stale worker's completion is fenced out
  // (returns false) instead of clobbering the reclaimer's job state.
  const claimant = `r2-cold-snapshot:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  // 2h lease: gzip-streaming a ~10 GB backup into sequential multipart parts is
  // normally minutes, but a degraded uplink must not let a second drain start a
  // concurrent ~10 GB backup + racing upload of the same key.
  const jobs = claimDueJobs(R2_COLD_SNAPSHOT_JOB_TYPE, {
    limit: 1,
    leaseMs: 120 * 60_000,
    claimant,
    now: new Date(now),
  });
  if (jobs.length === 0) return { drained: 0 };

  let lastRun: R2ColdSnapshotRunResult | undefined;
  for (const job of jobs) {
    try {
      const result = await performR2ColdSnapshot(now, deps);
      lastRun = result;
      if (result.status === "error") {
        failDueJob(job.id, claimant, result.reason ?? "snapshot_failed");
      } else {
        completeDueJob(job.id, claimant, {
          status: result.status,
          reason: result.reason,
          key: result.key,
          bytes: result.bytes,
          rawBytes: result.rawBytes,
          parts: result.parts,
          prunedCount: result.pruned?.length ?? 0,
          skipPrune: result.skipPrune ?? false,
        });
      }
    } catch (err) {
      // performR2ColdSnapshot never throws; this is a belt-and-suspenders fence.
      failDueJob(job.id, claimant, err instanceof Error ? err.message : String(err));
    }
  }

  audit("r2_cold_snapshot.drain", {
    drained: jobs.length,
    lastStatus: lastRun?.status,
    stats: getDueJobStats(R2_COLD_SNAPSHOT_JOB_TYPE),
  });
  return { drained: jobs.length, lastRun };
}

// ── Freshness watchdog (watches what /api/health publishes) ──────────────────

export type R2WeeklyHealthState = "ok" | "archive_stale" | "archive_not_run";

/** Collapse the public health shape to the single state we alert transitions on. Pure. */
export function r2WeeklyHealthState(status: R2WeeklyHealthStatus): R2WeeklyHealthState {
  if (status.ok) return "ok";
  return status.reason === "archive_stale" ? "archive_stale" : "archive_not_run";
}

export interface R2WeeklyFreshnessReport {
  state: R2WeeklyHealthState;
  previous: R2WeeklyHealthState | null;
  changed: boolean;
}

/**
 * Watch `checks.storage.r2Weekly` — the field the public health endpoint already
 * publishes and which nothing was watching — and emit ONE Sentry event per state
 * TRANSITION plus the usual storage_warning advisory on degrade.  Cheap by construction:
 * a single internal-setting read on a tick where nothing changed.  Never throws.
 */
export async function reportR2WeeklyFreshness(
  now: number = Date.now(),
  deps: Pick<R2ColdSnapshotDeps, "alertImpl"> = {},
): Promise<R2WeeklyFreshnessReport> {
  try {
    const status = getR2WeeklyHealthStatus(now);
    const state = r2WeeklyHealthState(status);
    const previous = getInternalSetting<R2WeeklyHealthState>(R2_COLD_SNAPSHOT_HEALTH_STATE_KEY) ?? null;
    if (previous === state) return { state, previous, changed: false };

    // Emit FIRST, persist LAST.  The stored state is what suppresses the next tick, so
    // writing it before the event has been emitted would lose the transition forever if
    // anything in between threw: the next tick would see the new state as `previous` and
    // conclude nothing changed.  Persisting last means a mid-flight failure at worst
    // repeats the event next tick, which for an archive-staleness watchdog is strictly
    // the right way to be wrong.  logWarn/logError are fire-and-forget and cannot throw;
    // the audit row and the advisory are each guarded so neither can skip the write.
    const ageDays = status.ageSeconds === null ? null : Number((status.ageSeconds / 86400).toFixed(2));
    if (state === "ok") {
      logWarn("r2 cold snapshot archive recovered", {
        previous,
        ageSeconds: status.ageSeconds,
        key: status.key,
      });
    } else {
      logError("r2 cold snapshot archive stale", {
        state,
        previous,
        ageSeconds: status.ageSeconds,
        ageDays,
        maxAgeSeconds: R2_ARCHIVE_MAX_AGE_SECONDS,
        key: status.key,
      });
    }

    try {
      audit("r2_cold_snapshot.health_change", {
        from: previous,
        to: state,
        ageSeconds: status.ageSeconds,
        key: status.key,
        maxAgeSeconds: R2_ARCHIVE_MAX_AGE_SECONDS,
      });
    } catch {
      /* observability only — must not cost us the state write below */
    }

    if (state !== "ok") {
      const alert = deps.alertImpl ?? defaultAlert;
      try {
        await alert(
          "r2_cold_snapshot_stale",
          state === "archive_not_run"
            ? `Weekly R2 cold snapshot has never completed — the independent archive tier is EMPTY. ` +
                `Litestream/B2 continuous replication is unaffected.`
            : `Weekly R2 cold snapshot is ${ageDays ?? "?"} days old (limit ` +
                `${R2_ARCHIVE_MAX_AGE_SECONDS / 86400} days); newest archive object is ${status.key}. ` +
                `The independent archive tier is not advancing. Litestream/B2 continuous ` +
                `replication is unaffected.`,
        );
      } catch {
        /* advisory only */
      }
    }

    setInternalSetting(R2_COLD_SNAPSHOT_HEALTH_STATE_KEY, state);
    return { state, previous, changed: true };
  } catch {
    // Watchdogs must never throw into the scheduler tick.
    return { state: "archive_not_run", previous: null, changed: false };
  }
}
