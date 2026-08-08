// r2-cold-snapshot.ts — weekly cold snapshot of the production SQLite DB to Cloudflare R2.
//
// Owner directive (2026-08-08): with litestream's active replica moved to Backblaze B2
// (PR #2584), the R2 bucket sits idle — use it intelligently as SECOND-PROVIDER disaster
// recovery. Once a week (Sunday ~03:17 UTC, staggered off the top of the hour), take a
// consistent better-sqlite3 `backup()` of the live DB to a temp file and multipart-upload
// it to the historic R2 bucket under `cold-snapshots/app-<ISO-date>.db`, then prune to the
// newest N (default 4) snapshots.
//
// Budget stance: stays reliably far under the R2 free tier. One weekly run costs ~20
// Class A ops (create + ~16 parts at 100 MB + complete + list + up to a couple deletes)
// ≈ 90/month vs the 1M free-tier allowance; storage is retain×DB-size (4 × ~1.5 GB ≈ 6 GB
// of the 10 GiB tier — shared with any historic litestream objects; the r2-usage monitor's
// absolute storage alert remains the watchdog for that headroom). A budget guard refuses
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
//
// Failure: audited, and surfaced once via the existing storage_warning notification path
// (db-health.ts alertStorageWarning — 12h per-warning-type cooldown), then retried with
// due-job backoff. Never throws into the scheduler tick.

// Bare "fs"/"os"/"path" (not the "node:" scheme) so Next.js webpack can externalize this
// module for server bundles — same trap as r2-usage.ts / egress-guard.
import crypto from "crypto";
import { closeSync, existsSync, openSync, readSync, statSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { audit, databasePath, getDb } from "./db";
import { getInternalSetting, setInternalSetting } from "./db-settings";
import {
  claimDueJobs,
  completeDueJob,
  enqueueDueJob,
  failDueJob,
  getDueJobStats,
} from "./db-jobs";
import { getR2UsageSnapshots, R2_FREE_TIER } from "./r2-usage";

// ── Constants ────────────────────────────────────────────────────────────────

export const R2_COLD_SNAPSHOT_JOB_TYPE = "r2_cold_snapshot";
export const R2_COLD_SNAPSHOT_PREFIX = "cold-snapshots/";
/** Weekly slot: Sunday, 03:17 UTC (staggered off the top of the hour so it never
 *  stampedes with other fleet crons that fire at :00). */
export const R2_COLD_SNAPSHOT_UTC_DAY = 0; // Sunday
export const R2_COLD_SNAPSHOT_UTC_HOUR = 3;
export const R2_COLD_SNAPSHOT_UTC_MINUTE = 17;
export const R2_COLD_SNAPSHOT_DEFAULT_RETAIN = 4;
export const R2_COLD_SNAPSHOT_DEFAULT_PART_BYTES = 100 * 1024 * 1024; // 100 MB parts
/** S3 floor for every part except the last. */
export const R2_COLD_SNAPSHOT_MIN_PART_BYTES = 5 * 1024 * 1024;
/** Refuse to run when the ST account's month-to-date Class A ops exceed this share
 *  of the free tier (read from the r2-usage monitor's persisted snapshot). */
export const R2_COLD_SNAPSHOT_BUDGET_GUARD_PCT = 50;

const DISABLED_AUDIT_KEY = "r2coldsnap:disabledAuditedReason";
const KEY_PATTERN = /^cold-snapshots\/app-\d{4}-\d{2}-\d{2}\.db$/;

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
}

/**
 * Env names follow PR #2584's convention: the R2 credentials preserved when litestream's
 * active replica moved to B2 live as AWS_R2_HISTORIC_* (Infisical + .env.example).
 * Default ON only when the full credential set exists; R2_COLD_SNAPSHOT_ENABLED is the
 * explicit kill switch (off/false/0/no).
 */
export function loadR2ColdSnapshotConfig(): R2ColdSnapshotConfig {
  const bucket = process.env.AWS_R2_HISTORIC_BUCKET_NAME?.trim() ?? "";
  const endpoint = process.env.AWS_R2_HISTORIC_ENDPOINT?.trim() ?? "";
  const region = process.env.AWS_R2_HISTORIC_REGION?.trim() || "auto";
  const accessKeyId = process.env.AWS_R2_HISTORIC_ACCESS_KEY_ID?.trim() ?? "";
  const secretAccessKey = process.env.AWS_R2_HISTORIC_SECRET_ACCESS_KEY?.trim() ?? "";
  const retainRaw = Number(process.env.R2_COLD_SNAPSHOT_RETAIN ?? "");
  const retain = Number.isFinite(retainRaw) && retainRaw >= 1 ? Math.floor(retainRaw) : R2_COLD_SNAPSHOT_DEFAULT_RETAIN;
  const partMbRaw = Number(process.env.R2_COLD_SNAPSHOT_PART_MB ?? "");
  const partSizeBytes =
    Number.isFinite(partMbRaw) && partMbRaw * 1024 * 1024 >= R2_COLD_SNAPSHOT_MIN_PART_BYTES
      ? Math.floor(partMbRaw * 1024 * 1024)
      : R2_COLD_SNAPSHOT_DEFAULT_PART_BYTES;

  const killRaw = process.env.R2_COLD_SNAPSHOT_ENABLED?.trim().toLowerCase();
  const killed = killRaw === "0" || killRaw === "off" || killRaw === "false" || killRaw === "no";
  const hasCreds = Boolean(bucket && endpoint && accessKeyId && secretAccessKey);

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

export interface MultipartPartPlan {
  partNumber: number;
  offset: number;
  length: number;
}

/** Split `totalBytes` into sequential parts of `partSizeBytes` (last part may be
 *  smaller). A zero-byte file still yields one empty part (S3 allows a single
 *  0-byte part). Pure. */
export function planMultipartParts(totalBytes: number, partSizeBytes: number): MultipartPartPlan[] {
  if (totalBytes <= 0) return [{ partNumber: 1, offset: 0, length: 0 }];
  const parts: MultipartPartPlan[] = [];
  let offset = 0;
  let partNumber = 1;
  while (offset < totalBytes) {
    const length = Math.min(partSizeBytes, totalBytes - offset);
    parts.push({ partNumber, offset, length });
    offset += length;
    partNumber += 1;
  }
  return parts;
}

/**
 * Retention: given a bucket listing, return the cold-snapshot keys to DELETE so only the
 * newest `retain` remain. Defensive: only keys matching our exact
 * `cold-snapshots/app-YYYY-MM-DD.db` pattern are ever candidates — historic litestream
 * objects (different prefix/shape) can never be pruned by this lane. Snapshot keys embed
 * the ISO date, so lexical sort == chronological sort. Pure.
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
  /** Test seam for better-sqlite3's online-backup API. Default: getDb().backup(dest). */
  backupImpl?: (destPath: string) => Promise<unknown>;
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

// ── The snapshot itself ──────────────────────────────────────────────────────

export interface R2ColdSnapshotRunResult {
  status: "ok" | "skipped" | "error";
  reason?: string;
  key?: string;
  bytes?: number;
  parts?: number;
  pruned?: string[];
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

  // Budget guard: the weekly upload is ~20 Class A ops, but if the month's Class A count
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
  const key = `${R2_COLD_SNAPSHOT_PREFIX}app-${isoDate}.db`;
  // Snapshot lands beside the live DB on the persistent volume (same filesystem —
  // no cross-device copy, guaranteed writable) rather than the OS temp dir: the
  // edge-flavored instrumentation webpack pass cannot resolve the "os" builtin.
  const tempPath = join(dirname(databasePath()), `.r2snap-${crypto.randomUUID()}.db.tmp`);
  const partSizeBytes = deps.partSizeBytes ?? cfg.partSizeBytes;
  let uploadId: string | undefined;

  try {
    audit("r2_cold_snapshot.start", { key, tempPath, partSizeBytes });

    // Consistent online backup — NEVER a raw copy of the live WAL-mode file.
    const backupImpl = deps.backupImpl ?? ((dest: string) => getDb().backup(dest));
    await backupImpl(tempPath);
    const totalBytes = statSync(tempPath).size;
    const plan = planMultipartParts(totalBytes, partSizeBytes);

    uploadId = await createMultipartUpload(cfg, key, deps);
    const completedParts: Array<{ partNumber: number; etag: string }> = [];
    const fd = openSync(tempPath, "r");
    try {
      for (const part of plan) {
        const buffer = Buffer.alloc(part.length);
        if (part.length > 0) {
          let read = 0;
          while (read < part.length) {
            const n = readSync(fd, buffer, read, part.length - read, part.offset + read);
            if (n <= 0) throw new Error(`short read at offset ${part.offset + read}`);
            read += n;
          }
        }
        const etag = await uploadPart(cfg, key, uploadId, part.partNumber, buffer, deps);
        completedParts.push({ partNumber: part.partNumber, etag });
      }
    } finally {
      closeSync(fd);
    }
    await completeMultipartUpload(cfg, key, uploadId, completedParts, deps);
    uploadId = undefined; // completed — nothing to abort from here on

    // Retention: keep the newest `retain` snapshots, delete the rest. A prune failure
    // does not fail the run — the snapshot IS uploaded; next week's prune catches up.
    let pruned: string[] = [];
    try {
      const keys = await listColdSnapshotKeys(cfg, deps);
      pruned = selectColdSnapshotsToPrune(keys, cfg.retain);
      for (const k of pruned) await deleteObject(cfg, k, deps);
    } catch (err) {
      audit("r2_cold_snapshot.prune_error", { key, error: err instanceof Error ? err.message : String(err) });
      pruned = [];
    }

    const durationMs = Date.now() - startedAt;
    audit("r2_cold_snapshot.success", {
      key,
      bytes: totalBytes,
      parts: plan.length,
      pruned,
      retain: cfg.retain,
      durationMs,
    });
    return { status: "ok", key, bytes: totalBytes, parts: plan.length, pruned, durationMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (uploadId) await abortMultipartUpload(cfg, key, uploadId, deps);
    try {
      audit("r2_cold_snapshot.error", { key, error: message, durationMs: Date.now() - startedAt });
    } catch {
      /* never throw */
    }
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
  const claimant = `r2-cold-snapshot:${process.pid}`;
  // 45 min lease: ~16 sequential 100 MB parts can legitimately take a while.
  const jobs = claimDueJobs(R2_COLD_SNAPSHOT_JOB_TYPE, {
    limit: 1,
    leaseMs: 45 * 60_000,
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
          parts: result.parts,
          prunedCount: result.pruned?.length ?? 0,
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
