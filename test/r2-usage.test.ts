import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assessR2Usage,
  classifyR2Action,
  fetchR2RawUsage,
  formatR2MetricValue,
  getR2UsageSnapshot,
  isR2UsageCheckDue,
  r2AlertTransitions,
  r2MonthWindow,
  runR2UsageCheck,
  R2_FREE_TIER,
} from "../src/lib/r2-usage";
import { deleteInternalSetting } from "../src/lib/db-settings";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-r2usage-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  deleteInternalSetting("r2usage:lastSnapshot");
  deleteInternalSetting("r2usage:alertState");
  deleteInternalSetting("r2usage:lastCheckAt");
  delete process.env.CLOUDFLARE_ST_API_TOKEN;
  delete process.env.CLOUDFLARE_ST_ACCOUNT_ID;
  delete process.env.R2_USAGE_MONITOR_INTERVAL_HOURS;
  delete process.env.R2_USAGE_ALERT_THRESHOLD_PCT;
  delete process.env.R2_USAGE_BUCKET_FILTER;
});

// 2026-07-16T00:00:00Z — exactly mid-month-ish for July (31 days): 15/31 elapsed.
const MID_JULY = Date.UTC(2026, 6, 16);

describe("classifyR2Action", () => {
  it("maps read operations to Class B", () => {
    expect(classifyR2Action("GetObject")).toBe("B");
    expect(classifyR2Action("HeadObject")).toBe("B");
    expect(classifyR2Action("HeadBucket")).toBe("B");
    expect(classifyR2Action("GetBucketNotificationConfiguration")).toBe("B");
    expect(classifyR2Action("GetBucketSippyConfiguration")).toBe("B");
  });
  it("maps writes/lists/deletes/multipart to Class A", () => {
    for (const a of [
      "PutObject", "CopyObject", "DeleteObject", "DeleteObjects",
      "ListBuckets", "ListObjectsV2", "ListMultipartUploads", "ListParts",
      "CreateMultipartUpload", "UploadPart", "UploadPartCopy",
      "CompleteMultipartUpload", "AbortMultipartUpload",
    ]) {
      expect(classifyR2Action(a)).toBe("A");
    }
  });
  it("falls unknown action types to Class A (conservative: tighter quota)", () => {
    expect(classifyR2Action("SomeFutureAction")).toBe("A");
  });
});

describe("r2MonthWindow", () => {
  it("computes UTC month bounds and elapsed fraction", () => {
    const w = r2MonthWindow(MID_JULY);
    expect(w.startISO).toBe("2026-07-01T00:00:00.000Z");
    expect(w.endISO).toBe("2026-08-01T00:00:00.000Z");
    // 15 of 31 days elapsed
    expect(w.elapsedFraction).toBeCloseTo(15 / 31, 3);
  });
  it("floors the elapsed fraction at ~1h so early-month projections can't explode", () => {
    const firstMinute = Date.UTC(2026, 6, 1, 0, 1);
    const w = r2MonthWindow(firstMinute);
    expect(w.elapsedFraction).toBeGreaterThan(0.001);
    expect(w.elapsedFraction).toBeLessThan(0.01);
  });
});

describe("assessR2Usage", () => {
  it("flags a metric when projected month-end exceeds the threshold", () => {
    // 40% of Class A used by mid-month → projected ~80% > 70 threshold.
    const metrics = assessR2Usage({
      storageBytes: 0,
      classAOps: 400_000,
      classBOps: 0,
      thresholdPct: 70,
      now: MID_JULY,
    });
    const classA = metrics.find((m) => m.id === "classA")!;
    expect(classA.pctUsed).toBeCloseTo(40, 1);
    expect(classA.projectedPct).toBeGreaterThan(70);
    expect(classA.exceeded).toBe(true);
  });
  it("does not flag usage pacing under the threshold", () => {
    const metrics = assessR2Usage({
      storageBytes: 1 * 1024 ** 3, // 1 GiB mid-month → ~2 GiB projected = 20%
      classAOps: 100_000, // → ~200k projected = 20%
      classBOps: 1_000_000, // → ~2M projected = 20%
      thresholdPct: 70,
      now: MID_JULY,
    });
    expect(metrics.every((m) => !m.exceeded)).toBe(true);
  });
  it("uses the correct free-tier limits", () => {
    expect(R2_FREE_TIER.storageBytes).toBe(10 * 1024 ** 3);
    expect(R2_FREE_TIER.classAOps).toBe(1_000_000);
    expect(R2_FREE_TIER.classBOps).toBe(10_000_000);
  });
});

describe("r2AlertTransitions", () => {
  const mk = (id: "storage" | "classA" | "classB", exceeded: boolean) => ({
    id, label: id, mtd: 0, limit: 1, pctUsed: 0, projected: 0, projectedPct: exceeded ? 99 : 1, exceeded, unit: "ops" as const,
  });
  it("emits crossed only on ok → exceeded", () => {
    const t = r2AlertTransitions({}, [mk("storage", true)]);
    expect(t).toHaveLength(1);
    expect(t[0].direction).toBe("crossed");
  });
  it("stays silent while steady-exceeded (no alert spam)", () => {
    const t = r2AlertTransitions({ storage: "exceeded" }, [mk("storage", true)]);
    expect(t).toHaveLength(0);
  });
  it("emits recovered on exceeded → ok", () => {
    const t = r2AlertTransitions({ storage: "exceeded" }, [mk("storage", false)]);
    expect(t).toHaveLength(1);
    expect(t[0].direction).toBe("recovered");
  });
});

function graphqlStorageAndOps(payloadSize: number, classA: number, classB: number) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const query = String(init?.body ?? "");
    if (query.includes("r2StorageAdaptiveGroups")) {
      return new Response(JSON.stringify({
        data: { viewer: { accounts: [{ r2StorageAdaptiveGroups: [
          { max: { objectCount: 7, payloadSize }, dimensions: { bucketName: "socratic-trade-bucket", datetime: "2026-07-16T00:00:00Z" } },
        ] }] } },
        errors: null,
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: [
        { sum: { requests: classA }, dimensions: { actionType: "PutObject", bucketName: "b" } },
        { sum: { requests: classB }, dimensions: { actionType: "GetObject", bucketName: "b" } },
      ] }] } },
      errors: null,
    }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("fetchR2RawUsage", () => {
  it("sums storage per bucket and splits operations by billing class", async () => {
    const w = r2MonthWindow(MID_JULY);
    const raw = await fetchR2RawUsage("acct", "token", w, null, { fetchImpl: graphqlStorageAndOps(1234, 500, 900) });
    expect(raw.storageBytes).toBe(1234);
    expect(raw.objectCount).toBe(7);
    expect(raw.classAOps).toBe(500);
    expect(raw.classBOps).toBe(900);
    expect(raw.buckets[0].name).toBe("socratic-trade-bucket");
  });
  it("throws on graphql errors", async () => {
    const bad = (async () => new Response(JSON.stringify({ data: null, errors: [{ message: "bad filter" }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchR2RawUsage("acct", "token", r2MonthWindow(MID_JULY), null, { fetchImpl: bad })).rejects.toThrow("bad filter");
  });
});

describe("runR2UsageCheck", () => {
  it("skips silently when credentials are not configured", async () => {
    const res = await runR2UsageCheck(MID_JULY);
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("not_configured");
  });

  it("persists a snapshot and alerts once when a metric crosses the threshold", async () => {
    process.env.CLOUDFLARE_ST_API_TOKEN = "t";
    process.env.CLOUDFLARE_ST_ACCOUNT_ID = "acct";
    const notifyCalls: Array<{ title: string; body: string }> = [];
    const notifyImpl = (async (_u: string, msg: { title: string; body: string }) => {
      notifyCalls.push(msg);
      return [];
    }) as never;
    const deps = { fetchImpl: graphqlStorageAndOps(8 * 1024 ** 3, 100, 100), notifyImpl };

    // 8 GiB by mid-month → projected ~16.5 GiB = 165% → crossed.
    const first = await runR2UsageCheck(MID_JULY, deps);
    expect(first.status).toBe("ok");
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].title).toContain("Storage");
    expect(notifyCalls[0].title).toContain("⚠️");

    const snap = getR2UsageSnapshot()!;
    expect(snap.metrics.find((m) => m.id === "storage")!.exceeded).toBe(true);

    // Second identical run: steady-exceeded → no repeat alert.
    const second = await runR2UsageCheck(MID_JULY + 3600_000, deps);
    expect(second.status).toBe("ok");
    expect(notifyCalls).toHaveLength(1);
  });

  it("sends a recovery notice when pace drops back under the threshold", async () => {
    process.env.CLOUDFLARE_ST_API_TOKEN = "t";
    process.env.CLOUDFLARE_ST_ACCOUNT_ID = "acct";
    const notifyCalls: Array<{ title: string; body: string }> = [];
    const notifyImpl = (async (_u: string, msg: { title: string; body: string }) => {
      notifyCalls.push(msg);
      return [];
    }) as never;

    await runR2UsageCheck(MID_JULY, {
      fetchImpl: graphqlStorageAndOps(8 * 1024 ** 3, 100, 100),
      notifyImpl,
    });
    // Usage shrinks (bucket cleaned) → recovery.
    await runR2UsageCheck(MID_JULY + 3600_000, {
      fetchImpl: graphqlStorageAndOps(1 * 1024 ** 3, 100, 100),
      notifyImpl,
    });
    expect(notifyCalls).toHaveLength(2);
    expect(notifyCalls[1].title).toContain("✅");
  });

  it("isR2UsageCheckDue gates on credentials and interval", async () => {
    expect(isR2UsageCheckDue(MID_JULY)).toBe(false); // no creds
    process.env.CLOUDFLARE_ST_API_TOKEN = "t";
    process.env.CLOUDFLARE_ST_ACCOUNT_ID = "acct";
    expect(isR2UsageCheckDue(MID_JULY)).toBe(true); // never ran
    await runR2UsageCheck(MID_JULY, { fetchImpl: graphqlStorageAndOps(0, 0, 0), notifyImpl: (async () => []) as never });
    // runR2UsageCheck doesn't set the cadence watermark (runR2UsageCheckIfDue does),
    // so it remains due — guard against accidental coupling.
    expect(isR2UsageCheckDue(MID_JULY + 1000)).toBe(true);
  });
});

describe("formatR2MetricValue", () => {
  it("formats bytes as GiB and ops with separators", () => {
    const bytesM = assessR2Usage({ storageBytes: 2 * 1024 ** 3, classAOps: 0, classBOps: 0, thresholdPct: 70, now: MID_JULY })[0];
    expect(formatR2MetricValue(bytesM)).toBe("2.00 GiB");
    const opsM = assessR2Usage({ storageBytes: 0, classAOps: 123_456, classBOps: 0, thresholdPct: 70, now: MID_JULY })[1];
    expect(formatR2MetricValue(opsM)).toBe("123,456");
  });
});
