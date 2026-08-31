// r2-cold-snapshot.test.ts — weekly R2 cold-snapshot lane (src/lib/r2-cold-snapshot.ts).
//
// Covers: config gating (creds + kill switch), the no-op-without-creds contract (single
// audit row), weekly due-at math, retention pruning across BOTH extensions (.db legacy +
// .db.gz), the full snapshot+gzip+upload drain path against a mocked S3 layer (including
// gunzip round-trip verification of the uploaded parts), temp-file cleanup on success AND
// failure, and the Class A budget guard.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { databasePath } from "../src/lib/db";
import {
  drainR2ColdSnapshotJobs,
  ensureR2ColdSnapshotJobScheduled,
  getR2WeeklyHealthStatus,
  loadR2ColdSnapshotConfig,
  nextR2ColdSnapshotDueAt,
  r2ColdSnapshotClassAPct,
  selectColdSnapshotsToPrune,
  R2_ARCHIVE_MAX_AGE_SECONDS,
  R2_COLD_SNAPSHOT_DEFAULT_PART_BYTES,
  R2_COLD_SNAPSHOT_DEFAULT_RETAIN,
  R2_COLD_SNAPSHOT_JOB_TYPE,
  R2_COLD_SNAPSHOT_LAST_FAILURE_KEY,
  R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY,
} from "../src/lib/r2-cold-snapshot";
import { enqueueDueJob } from "../src/lib/db-jobs";
import { getDb } from "../src/lib/db";
import { deleteInternalSetting, getInternalSetting, setInternalSetting } from "../src/lib/db-settings";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-r2coldsnap-${randomUUID()}.db`)}`;
});

const CRED_ENVS = [
  "AWS_R2_HISTORIC_BUCKET_NAME",
  "AWS_R2_HISTORIC_ENDPOINT",
  "AWS_R2_HISTORIC_REGION",
  "AWS_R2_HISTORIC_ACCESS_KEY_ID",
  "AWS_R2_HISTORIC_SECRET_ACCESS_KEY",
  "R2_COLD_SNAPSHOT_ENABLED",
  "R2_COLD_SNAPSHOT_RETAIN",
  "R2_ARCHIVE_KEEP_GENERATIONS",
  "R2_COLD_SNAPSHOT_PART_MB",
] as const;

function setCreds(): void {
  process.env.AWS_R2_HISTORIC_BUCKET_NAME = "socratic-trade-bucket";
  process.env.AWS_R2_HISTORIC_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.AWS_R2_HISTORIC_ACCESS_KEY_ID = "AKIATEST";
  process.env.AWS_R2_HISTORIC_SECRET_ACCESS_KEY = "secret";
}

beforeEach(() => {
  for (const k of CRED_ENVS) delete process.env[k];
  deleteInternalSetting("r2coldsnap:disabledAuditedReason");
  deleteInternalSetting(R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY);
  deleteInternalSetting(R2_COLD_SNAPSHOT_LAST_FAILURE_KEY);
  deleteInternalSetting("r2usage:lastSnapshots");
  getDb().prepare("DELETE FROM due_jobs WHERE job_type = ?").run(R2_COLD_SNAPSHOT_JOB_TYPE);
  getDb().prepare("DELETE FROM audit_events WHERE kind LIKE 'r2_cold_snapshot%'").run();
});

function auditCount(kind: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = ?").get(kind) as { n: number };
  return row.n;
}

function jobRows(): Array<{ status: string; due_at: string; dedupe_key: string | null }> {
  return getDb()
    .prepare("SELECT status, due_at, dedupe_key FROM due_jobs WHERE job_type = ? ORDER BY due_at")
    .all(R2_COLD_SNAPSHOT_JOB_TYPE) as Array<{ status: string; due_at: string; dedupe_key: string | null }>;
}

// ── Mocked S3 layer ──────────────────────────────────────────────────────────

interface RecordedRequest {
  method: string;
  url: string;
  body?: Uint8Array;
}

function mockS3(options: {
  listKeys?: string[];
  failCreate?: boolean;
  failPart?: number;
}): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ method, url, body: init?.body as Uint8Array | undefined });
    const respond = (status: number, body: string, headers: Record<string, string> = {}) =>
      // 204 is a null-body status — the Response constructor throws on any body, even "".
      new Response(status === 204 ? null : body, { status, headers });

    if (url.includes("uploads=")) {
      if (options.failCreate) return respond(500, "<Error>boom</Error>");
      return respond(200, "<InitiateMultipartUploadResult><UploadId>UP123</UploadId></InitiateMultipartUploadResult>");
    }
    if (url.includes("partNumber=")) {
      const part = Number(/partNumber=(\d+)/.exec(url)?.[1]);
      if (options.failPart === part) return respond(500, "<Error>part boom</Error>");
      return respond(200, "", { etag: `"etag-${part}"` });
    }
    if (method === "POST" && url.includes("uploadId=")) {
      return respond(200, "<CompleteMultipartUploadResult><Key>x</Key></CompleteMultipartUploadResult>");
    }
    if (method === "DELETE" && url.includes("uploadId=")) {
      return respond(204, "");
    }
    if (url.includes("list-type=2")) {
      const keys = (options.listKeys ?? []).map((k) => `<Key>${k}</Key>`).join("");
      return respond(200, `<ListBucketResult>${keys}<IsTruncated>false</IsTruncated></ListBucketResult>`);
    }
    if (method === "DELETE") {
      return respond(204, "");
    }
    return respond(404, "<Error>unexpected</Error>");
  }) as typeof fetch;
  return { fetchImpl, requests };
}

/** backupImpl test seam: writes `size` INCOMPRESSIBLE bytes to the destination and
 *  records the path + content.  Random bytes keep gzip output ~= input size, so a
 *  small partSizeBytes still exercises real multi-part uploads of the gzip stream. */
function fakeBackup(size: number, captured: { path?: string; content?: Buffer }) {
  return async (destPath: string) => {
    captured.path = destPath;
    captured.content = randomBytes(size);
    writeFileSync(destPath, captured.content);
  };
}

// ── Config gating ────────────────────────────────────────────────────────────

describe("loadR2ColdSnapshotConfig", () => {
  it("is disabled without the AWS_R2_HISTORIC_* credentials", () => {
    const cfg = loadR2ColdSnapshotConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.disabledReason).toBe("missing_credentials");
  });

  it("is enabled by default when the full credential set exists", () => {
    setCreds();
    const cfg = loadR2ColdSnapshotConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.disabledReason).toBeUndefined();
    expect(cfg.host).toBe("acct.r2.cloudflarestorage.com");
    expect(cfg.region).toBe("auto");
    expect(cfg.retain).toBe(R2_COLD_SNAPSHOT_DEFAULT_RETAIN);
    expect(cfg.partSizeBytes).toBe(R2_COLD_SNAPSHOT_DEFAULT_PART_BYTES);
  });

  it("honors the explicit kill switch even with credentials present", () => {
    setCreds();
    process.env.R2_COLD_SNAPSHOT_ENABLED = "off";
    const cfg = loadR2ColdSnapshotConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.disabledReason).toBe("kill_switch");
  });

  it("clamps part size to the 5 MB S3 floor and caps retain at 1 (free-tier)", () => {
    setCreds();
    process.env.R2_COLD_SNAPSHOT_PART_MB = "1"; // below the floor → default
    process.env.R2_COLD_SNAPSHOT_RETAIN = "6";
    const cfg = loadR2ColdSnapshotConfig();
    expect(cfg.partSizeBytes).toBe(R2_COLD_SNAPSHOT_DEFAULT_PART_BYTES);
    expect(R2_COLD_SNAPSHOT_DEFAULT_RETAIN).toBe(1);
    expect(cfg.retain).toBe(1);
  });

  it("does not let unused R2_ARCHIVE_KEEP_GENERATIONS drive weekly retain", () => {
    setCreds();
    process.env.R2_ARCHIVE_KEEP_GENERATIONS = "2";
    const cfg = loadR2ColdSnapshotConfig();
    expect(cfg.retain).toBe(R2_COLD_SNAPSHOT_DEFAULT_RETAIN);
  });
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("nextR2ColdSnapshotDueAt", () => {
  it("targets the next Sunday 03:17 UTC from a mid-week time", () => {
    const wed = Date.UTC(2026, 7, 5, 12, 0, 0); // Wednesday 2026-08-05
    const { dueAtISO, dedupeKey } = nextR2ColdSnapshotDueAt(wed);
    expect(dueAtISO).toBe("2026-08-09T03:17:00.000Z");
    expect(dedupeKey).toBe("week-2026-08-09");
  });

  it("uses the same Sunday when now is before 03:17 UTC that day", () => {
    const sunEarly = Date.UTC(2026, 7, 9, 2, 0, 0);
    expect(nextR2ColdSnapshotDueAt(sunEarly).dueAtISO).toBe("2026-08-09T03:17:00.000Z");
  });

  it("rolls to next week once the slot has passed", () => {
    const sunLate = Date.UTC(2026, 7, 9, 4, 0, 0);
    expect(nextR2ColdSnapshotDueAt(sunLate).dueAtISO).toBe("2026-08-16T03:17:00.000Z");
  });
});

describe("selectColdSnapshotsToPrune", () => {
  it("keeps the newest N and returns older snapshot keys for deletion", () => {
    const keys = [
      "cold-snapshots/app-2026-07-05.db",
      "cold-snapshots/app-2026-07-12.db",
      "cold-snapshots/app-2026-07-19.db",
      "cold-snapshots/app-2026-07-26.db",
      "cold-snapshots/app-2026-08-02.db",
      "cold-snapshots/app-2026-08-09.db",
    ];
    expect(selectColdSnapshotsToPrune(keys, 4).sort()).toEqual([
      "cold-snapshots/app-2026-07-05.db",
      "cold-snapshots/app-2026-07-12.db",
    ]);
    expect(selectColdSnapshotsToPrune(keys, 1).sort()).toEqual([
      "cold-snapshots/app-2026-07-05.db",
      "cold-snapshots/app-2026-07-12.db",
      "cold-snapshots/app-2026-07-19.db",
      "cold-snapshots/app-2026-07-26.db",
      "cold-snapshots/app-2026-08-02.db",
    ]);
  });

  it("counts .db and .db.gz together: the legacy raw .db prunes after the first .gz upload", () => {
    // Exactly the migration state: last raw upload from 2026-08-30 plus the first
    // gzipped upload from 2026-08-31.  retain=1 must delete the raw one.
    const keys = [
      "cold-snapshots/app-2026-08-30.db",
      "cold-snapshots/app-2026-08-31.db.gz",
    ];
    expect(selectColdSnapshotsToPrune(keys, 1)).toEqual(["cold-snapshots/app-2026-08-30.db"]);
  });

  it("treats a same-date .db.gz as newer than its .db twin", () => {
    const keys = [
      "cold-snapshots/app-2026-08-31.db",
      "cold-snapshots/app-2026-08-31.db.gz",
    ];
    expect(selectColdSnapshotsToPrune(keys, 1)).toEqual(["cold-snapshots/app-2026-08-31.db"]);
  });

  it("never touches keys outside the snapshot pattern (historic litestream data)", () => {
    const keys = [
      "app.db/generations/deadbeef/snapshots/000001.snapshot.lz4",
      "app.db/generations/deadbeef/wal/000001_0.wal.lz4",
      "cold-snapshots/app-2026-08-09.db.gz",
      "cold-snapshots/app-2026-08-02.db.gz.bak",
      "cold-snapshots/other-thing.txt",
    ];
    expect(selectColdSnapshotsToPrune(keys, 1)).toEqual([]);
  });

  it("returns empty when at or under the retention count", () => {
    expect(selectColdSnapshotsToPrune(["cold-snapshots/app-2026-08-09.db.gz"], 4)).toEqual([]);
  });
});

// ── Scheduling (due-jobs) ────────────────────────────────────────────────────

describe("ensureR2ColdSnapshotJobScheduled", () => {
  it("no-ops without creds, writing exactly one audit row across calls", () => {
    expect(ensureR2ColdSnapshotJobScheduled()).toBe(false);
    expect(ensureR2ColdSnapshotJobScheduled()).toBe(false);
    expect(jobRows()).toHaveLength(0);
    expect(auditCount("r2_cold_snapshot.disabled")).toBe(1);
  });

  it("enqueues one pending weekly job, deduped per week", () => {
    setCreds();
    const wed = Date.UTC(2026, 7, 5, 12, 0, 0);
    expect(ensureR2ColdSnapshotJobScheduled(wed)).toBe(true);
    expect(ensureR2ColdSnapshotJobScheduled(wed)).toBe(false); // dedupe key already present
    const rows = jobRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].due_at).toBe("2026-08-09T03:17:00.000Z");
    expect(rows[0].dedupe_key).toBe("week-2026-08-09");
  });
});

// ── Drain: full upload path, failure path, budget guard ──────────────────────

function enqueueDueNow(now: number): void {
  enqueueDueJob({
    jobType: R2_COLD_SNAPSHOT_JOB_TYPE,
    dedupeKey: `test-${randomUUID()}`,
    dueAt: new Date(now - 60_000).toISOString(),
  });
}

describe("drainR2ColdSnapshotJobs", () => {
  it("does nothing when no job is due", async () => {
    setCreds();
    const result = await drainR2ColdSnapshotJobs(Date.now(), { fetchImpl: mockS3({}).fetchImpl });
    expect(result.drained).toBe(0);
  });

  it("backs up, gzip-streams into multipart parts, prunes legacy .db + older .gz, cleans temp, completes the job", async () => {
    setCreds();
    const now = Date.UTC(2026, 7, 9, 3, 20, 0);
    enqueueDueNow(now);
    const staleKeys = [
      "cold-snapshots/app-2026-07-26.db", // legacy raw uploads — must prune after a .gz success
      "cold-snapshots/app-2026-08-02.db",
      "cold-snapshots/app-2026-08-09.db.gz", // the one just uploaded
      "app.db/generations/deadbeef/wal/000001_0.wal.lz4", // historic litestream — untouchable
    ];
    const s3 = mockS3({ listKeys: staleKeys });
    const captured: { path?: string; content?: Buffer } = {};

    const result = await drainR2ColdSnapshotJobs(now, {
      fetchImpl: s3.fetchImpl,
      backupImpl: fakeBackup(2500, captured),
      alertImpl: async () => {},
      partSizeBytes: 1000,
    });

    expect(result.drained).toBe(1);
    expect(result.lastRun?.status).toBe("ok");
    expect(result.lastRun?.key).toBe("cold-snapshots/app-2026-08-09.db.gz");
    // Random input is incompressible: gzip output = 2500 + header/trailer overhead.
    expect(result.lastRun?.rawBytes).toBe(2500);
    expect(result.lastRun?.bytes).toBeGreaterThan(2500);
    expect(result.lastRun?.bytes).toBeLessThan(2600);
    expect(result.lastRun?.parts).toBe(3); // 1000 + 1000 + tail

    // Gzip stream against the wire: sequential part numbers, full-size non-final parts,
    // and the concatenated parts gunzip back to the EXACT original backup bytes.
    const partPuts = s3.requests.filter((r) => r.method === "PUT" && r.url.includes("partNumber="));
    expect(partPuts.map((r) => Number(/partNumber=(\d+)/.exec(r.url)?.[1]))).toEqual([1, 2, 3]);
    expect(partPuts.slice(0, -1).map((r) => r.body?.byteLength)).toEqual([1000, 1000]);
    const uploaded = Buffer.concat(partPuts.map((r) => Buffer.from(r.body!)));
    expect(uploaded.byteLength).toBe(result.lastRun?.bytes);
    expect(gunzipSync(uploaded).equals(captured.content!)).toBe(true);

    // Complete carries every part's ETag.
    const complete = s3.requests.find((r) => r.method === "POST" && r.url.includes("uploadId="));
    const completeXml = Buffer.from(complete!.body!).toString("utf8");
    expect(completeXml).toContain("etag-1");
    expect(completeXml).toContain("etag-2");
    expect(completeXml).toContain("etag-3");

    // Retention pruned every older snapshot key across BOTH extensions — nothing else.
    // Default retain is 1 (free-tier cap; the raw DB is ~9.7 GB of a 10 GiB tier).
    const deletes = s3.requests.filter((r) => r.method === "DELETE");
    expect(deletes.map((r) => decodeURIComponent(new URL(r.url).pathname)).sort()).toEqual([
      "/socratic-trade-bucket/cold-snapshots/app-2026-07-26.db",
      "/socratic-trade-bucket/cold-snapshots/app-2026-08-02.db",
    ]);

    // Temp file removed; job completed.
    expect(captured.path).toBeTruthy();
    expect(captured.path!.startsWith(dirname(databasePath()))).toBe(true);
    expect(captured.path!).toMatch(/\.r2snap-.*\.db\.tmp$/);
    expect(existsSync(captured.path!)).toBe(false);
    expect(jobRows().map((r) => r.status)).toEqual(["done"]);
    expect(auditCount("r2_cold_snapshot.success")).toBe(1);

    // Health reader input: last success persisted for /api/health checks.storage.r2Weekly.
    const last = getInternalSetting<{ key: string; completedAt: string; bytes: number; rawBytes?: number }>(
      R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY,
    );
    expect(last).toMatchObject({
      key: "cold-snapshots/app-2026-08-09.db.gz",
      bytes: result.lastRun?.bytes,
      rawBytes: 2500,
    });
    expect(typeof last?.completedAt).toBe("string");
    expect(Number.isFinite(Date.parse(last!.completedAt))).toBe(true);
  });

  it("on upload failure: aborts the multipart upload, cleans the temp file, alerts once, retries the job", async () => {
    setCreds();
    const now = Date.UTC(2026, 7, 9, 3, 20, 0);
    enqueueDueNow(now);
    const s3 = mockS3({ failPart: 2 });
    const captured: { path?: string; content?: Buffer } = {};
    const alerts: string[] = [];

    const result = await drainR2ColdSnapshotJobs(now, {
      fetchImpl: s3.fetchImpl,
      backupImpl: fakeBackup(2500, captured),
      alertImpl: async (warningType) => {
        alerts.push(warningType);
      },
      partSizeBytes: 1000,
    });

    expect(result.lastRun?.status).toBe("error");
    // Abort was issued for the orphaned upload.
    const abort = s3.requests.find((r) => r.method === "DELETE" && r.url.includes("uploadId="));
    expect(abort).toBeTruthy();
    // Temp cleaned up even on failure.
    expect(existsSync(captured.path!)).toBe(false);
    // Advisory storage warning fired.
    expect(alerts).toEqual(["r2_cold_snapshot_failed"]);
    // Job went back to pending for a backoff retry, not terminally failed.
    expect(jobRows().map((r) => r.status)).toEqual(["pending"]);
    expect(auditCount("r2_cold_snapshot.error")).toBe(1);
    // Failure is recorded for ops; last success is left alone so health stays green
    // when a prior week still falls inside the 8-day window.
    const failure = getInternalSetting<{ key: string; reason: string }>(R2_COLD_SNAPSHOT_LAST_FAILURE_KEY);
    expect(failure?.key).toBe("cold-snapshots/app-2026-08-09.db.gz");
    expect(failure?.reason).toMatch(/UploadPart 2/);
    expect(getInternalSetting(R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY)).toBeUndefined();
  });

  it("budget guard: refuses to run when ST Class A usage is at/above 50%, without any S3 traffic", async () => {
    setCreds();
    const now = Date.UTC(2026, 7, 9, 3, 20, 0);
    enqueueDueNow(now);
    setInternalSetting("r2usage:lastSnapshots", [
      {
        accountId: "acct-st",
        accountLabel: "Socratic Trade",
        checkedAt: new Date(now).toISOString(),
        month: { startISO: "", endISO: "", elapsedFraction: 0.3 },
        thresholdPct: 70,
        bucketFilter: null,
        metrics: [
          { id: "classA", label: "Class A operations", mtd: 600_000, limit: 1_000_000, pctUsed: 60, projected: 0, projectedPct: 0, exceeded: false, alertBasis: "pace", unit: "ops" },
        ],
      },
    ]);
    const s3 = mockS3({});
    const alerts: string[] = [];

    const result = await drainR2ColdSnapshotJobs(now, {
      fetchImpl: s3.fetchImpl,
      backupImpl: async () => {
        throw new Error("backup must not run under budget refusal");
      },
      alertImpl: async (warningType) => {
        alerts.push(warningType);
      },
    });

    expect(result.lastRun?.status).toBe("skipped");
    expect(result.lastRun?.reason).toBe("budget");
    expect(s3.requests).toHaveLength(0);
    expect(alerts).toEqual(["r2_cold_snapshot_budget"]);
    expect(jobRows().map((r) => r.status)).toEqual(["done"]); // this week is skipped, not retried
    expect(auditCount("r2_cold_snapshot.budget_refused")).toBe(1);
  });

  it("completes (skip) rather than retrying when creds vanished after scheduling", async () => {
    setCreds();
    const now = Date.now();
    enqueueDueNow(now);
    for (const k of CRED_ENVS) delete process.env[k];
    const result = await drainR2ColdSnapshotJobs(now, { fetchImpl: mockS3({}).fetchImpl });
    expect(result.lastRun?.status).toBe("skipped");
    expect(result.lastRun?.reason).toBe("missing_credentials");
    expect(jobRows().map((r) => r.status)).toEqual(["done"]);
  });
});

describe("r2ColdSnapshotClassAPct", () => {
  it("returns null when the usage monitor has no snapshot", () => {
    expect(r2ColdSnapshotClassAPct()).toBeNull();
  });
});

// ── Health reader (public checks.storage.r2Weekly) ───────────────────────────

describe("getR2WeeklyHealthStatus", () => {
  const now = Date.UTC(2026, 7, 14, 12, 0, 0); // Friday 2026-08-14

  it("reports archive_not_run when no success has been persisted", () => {
    expect(getR2WeeklyHealthStatus(now)).toEqual({
      ok: false,
      ageSeconds: null,
      key: null,
      reason: "archive_not_run",
    });
  });

  it("reports ok with ageSeconds when the last success is within 8 days", () => {
    // Sunday 2026-08-09 03:17 UTC → ~5.4 days before `now` (well under 8d).
    const completedAt = "2026-08-09T03:17:00.000Z";
    setInternalSetting(R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY, {
      key: "cold-snapshots/app-2026-08-09.db",
      completedAt,
      bytes: 1_500_000_000,
    });
    const status = getR2WeeklyHealthStatus(now);
    expect(status).toEqual({
      ok: true,
      ageSeconds: Math.floor((now - Date.parse(completedAt)) / 1000),
      key: "cold-snapshots/app-2026-08-09.db",
      reason: null,
    });
    expect(status.ageSeconds!).toBeLessThanOrEqual(R2_ARCHIVE_MAX_AGE_SECONDS);
  });

  it("reports archive_stale when the last success is older than 8 days", () => {
    const completedAt = "2026-08-01T03:17:00.000Z"; // 13+ days before `now`
    setInternalSetting(R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY, {
      key: "cold-snapshots/app-2026-08-01.db",
      completedAt,
      bytes: 100,
    });
    const status = getR2WeeklyHealthStatus(now);
    expect(status.ok).toBe(false);
    expect(status.reason).toBe("archive_stale");
    expect(status.key).toBe("cold-snapshots/app-2026-08-01.db");
    expect(status.ageSeconds).toBe(Math.floor((now - Date.parse(completedAt)) / 1000));
    expect(status.ageSeconds!).toBeGreaterThan(R2_ARCHIVE_MAX_AGE_SECONDS);
  });

  it("stays ok when a later failure is recorded but the last success is still fresh", () => {
    const completedAt = "2026-08-09T03:17:00.000Z";
    setInternalSetting(R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY, {
      key: "cold-snapshots/app-2026-08-09.db",
      completedAt,
      bytes: 1,
    });
    setInternalSetting(R2_COLD_SNAPSHOT_LAST_FAILURE_KEY, {
      key: "cold-snapshots/app-2026-08-16.db",
      failedAt: "2026-08-16T03:20:00.000Z",
      reason: "UploadPart 1 HTTP 500",
    });
    // Evaluate just after a hypothetical failed retry window still inside 8 days of success.
    const justAfterFail = Date.UTC(2026, 7, 16, 4, 0, 0);
    const status = getR2WeeklyHealthStatus(justAfterFail);
    expect(status.ok).toBe(true);
    expect(status.reason).toBeNull();
    expect(status.key).toBe("cold-snapshots/app-2026-08-09.db");
  });

  it("treats a malformed completedAt as archive_not_run", () => {
    setInternalSetting(R2_COLD_SNAPSHOT_LAST_SUCCESS_KEY, {
      key: "cold-snapshots/app-2026-08-09.db",
      completedAt: "not-a-date",
      bytes: 1,
    });
    expect(getR2WeeklyHealthStatus(now)).toEqual({
      ok: false,
      ageSeconds: null,
      key: null,
      reason: "archive_not_run",
    });
  });
});
