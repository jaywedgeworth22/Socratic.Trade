// r2-usage.ts — Cloudflare R2 free-tier usage monitor.
//
// Owner directive (2026-07-30): never be on pace to exceed 70% of the R2 free
// tier in a month. Free tier: 10 GiB storage, 1M Class A operations, 10M
// Class B operations per month (per Cloudflare account, summed across buckets).
//
// A scheduler lane (default every 6h, leader-only) queries the Cloudflare
// GraphQL Analytics API for month-to-date storage + operation counts, projects
// month-end usage linearly, persists a snapshot for the admin dashboard, and
// sends a notify() alert when any metric crosses the threshold (and a recovery
// notice when it drops back under). Fully self-guarded: missing credentials
// disable the check silently and every failure is caught/logged, never thrown
// into the trading tick.
//
// Env:
//   CLOUDFLARE_ST_API_TOKEN    (required — Cloudflare API token w/ account analytics read)
//   CLOUDFLARE_ST_ACCOUNT_ID   (required — account tag, e.g. 94ec35cf…)
//   R2_USAGE_MONITOR_INTERVAL_HOURS  (default 6)
//   R2_USAGE_ALERT_THRESHOLD_PCT     (default 70)
//   R2_USAGE_BUCKET_FILTER           (optional — only count this bucket; default: whole account)

// Use bare "fs" (not the "node:" scheme) so Next.js webpack can externalize it for server
// bundles — the "node:" URI scheme fails client/edge compilation when this module is pulled
// in transitively (dashboard -> scheduler -> r2-usage), same trap as egress-guard's dns/net.
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { getInternalSetting, setInternalSetting } from "./db-settings";
import { audit } from "./db";
import { notify } from "./notify";

// ── Free tier + pure helpers (exported for tests) ────────────────────────────

export const R2_FREE_TIER = {
  storageBytes: 10 * 1024 ** 3, // 10 GiB
  classAOps: 1_000_000,
  classBOps: 10_000_000,
} as const;

export type R2OperationClass = "A" | "B";

/**
 * Map a Cloudflare r2OperationsAdaptiveGroups actionType to its billing class.
 * Class B = read-only object/bucket reads (GetObject, Head*, GetBucket* config
 * reads). Everything else (writes, deletes, multipart, List*) is Class A.
 * Unknown action types fall to "A" — overcounting the tighter quota (1M vs
 * 10M) is the conservative direction for alerting.
 */
export function classifyR2Action(actionType: string): R2OperationClass {
  if (actionType === "GetObject" || actionType === "HeadObject" || actionType === "HeadBucket") return "B";
  if (actionType.startsWith("GetBucket")) return "B";
  return "A";
}

export interface R2MonthWindow {
  startISO: string;
  endISO: string;
  /** Fraction of the month elapsed, in (0, 1] — floored at one hour's worth so
   *  early-month projections don't divide by ~0 and produce absurd values. */
  elapsedFraction: number;
}

export function r2MonthWindow(now: number): R2MonthWindow {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const total = end - start;
  const elapsed = Math.max(now - start, total / (31 * 24)); // ≥ ~1h of a month
  return {
    startISO: new Date(start).toISOString(),
    endISO: new Date(end).toISOString(),
    elapsedFraction: Math.min(elapsed / total, 1),
  };
}

export type R2MetricId = "storage" | "classA" | "classB";

export interface R2MetricAssessment {
  id: R2MetricId;
  label: string;
  mtd: number;
  limit: number;
  pctUsed: number;
  projected: number;
  projectedPct: number;
  /** Alert condition met (basis depends on metric — see alertBasis). */
  exceeded: boolean;
  /**
   * What drives `exceeded` for this metric:
   *  - "absolute": storage — a step-function stock metric (one bulk snapshot
   *    upload is not a continuing rate), so only absolute MTD usage vs the
   *    threshold alerts. Pace is displayed but never alerts.
   *  - "pace": operation counters — true rate metrics; pace alerts fire on
   *    the floored projection OR absolute MTD usage past the threshold.
   */
  alertBasis: "absolute" | "pace";
  unit: "bytes" | "ops";
}

/** Floor for the month-elapsed fraction used in ops pace projection. Without
 *  it, a one-time burst in the first days of a month (e.g. an initial
 *  litestream snapshot upload) projects to absurd month-end values (0.5%
 *  elapsed = 200x multiplier) and false-fires. 0.2 caps the multiplier at
 *  5x — still catches genuine runaway burn, tames month-start noise. */
export const R2_OPS_PACE_ELAPSED_FLOOR = 0.2;

export interface R2UsageAssessmentInput {
  storageBytes: number;
  classAOps: number;
  classBOps: number;
  thresholdPct: number;
  now: number;
}

export function assessR2Usage(input: R2UsageAssessmentInput): R2MetricAssessment[] {
  const { elapsedFraction } = r2MonthWindow(input.now);
  const mk = (
    id: R2MetricId,
    label: string,
    mtd: number,
    limit: number,
    unit: "bytes" | "ops",
  ): R2MetricAssessment => {
    const pctUsed = (mtd / limit) * 100;
    const alertBasis: "absolute" | "pace" = unit === "bytes" ? "absolute" : "pace";
    // Ops pace uses the floored elapsed fraction; storage shows raw pace for
    // display only (its alert is absolute — see alertBasis).
    const paceElapsed = alertBasis === "pace" ? Math.max(elapsedFraction, R2_OPS_PACE_ELAPSED_FLOOR) : elapsedFraction;
    const projected = mtd / paceElapsed;
    const projectedPct = (projected / limit) * 100;
    const exceeded =
      alertBasis === "absolute"
        ? pctUsed >= input.thresholdPct
        : projectedPct > input.thresholdPct || pctUsed >= input.thresholdPct;
    return {
      id,
      label,
      mtd,
      limit,
      pctUsed,
      projected,
      projectedPct,
      exceeded,
      alertBasis,
      unit,
    };
  };
  return [
    mk("storage", "Storage", input.storageBytes, R2_FREE_TIER.storageBytes, "bytes"),
    mk("classA", "Class A operations", input.classAOps, R2_FREE_TIER.classAOps, "ops"),
    mk("classB", "Class B operations", input.classBOps, R2_FREE_TIER.classBOps, "ops"),
  ];
}

export type R2AlertLevel = "ok" | "exceeded";
export type R2AlertState = Partial<Record<R2MetricId, R2AlertLevel>>;

export interface R2AlertTransition {
  metric: R2MetricAssessment;
  direction: "crossed" | "recovered";
}

/** Compare per-metric levels between checks; only transitions produce alerts. */
export function r2AlertTransitions(
  prev: R2AlertState,
  metrics: readonly R2MetricAssessment[],
): R2AlertTransition[] {
  const out: R2AlertTransition[] = [];
  for (const m of metrics) {
    const was: R2AlertLevel = prev[m.id] ?? "ok";
    const is: R2AlertLevel = m.exceeded ? "exceeded" : "ok";
    if (was === "ok" && is === "exceeded") out.push({ metric: m, direction: "crossed" });
    if (was === "exceeded" && is === "ok") out.push({ metric: m, direction: "recovered" });
  }
  return out;
}

export function formatR2MetricValue(m: R2MetricAssessment): string {
  if (m.unit === "bytes") {
    const gib = m.mtd / 1024 ** 3;
    return `${gib.toFixed(2)} GiB`;
  }
  return m.mtd.toLocaleString("en-US");
}

export function formatR2Projected(m: R2MetricAssessment): string {
  if (m.unit === "bytes") return `${(m.projected / 1024 ** 3).toFixed(2)} GiB`;
  return Math.round(m.projected).toLocaleString("en-US");
}

// ── Persisted snapshot (admin API reads this; no live CF call on page load) ──

export interface R2UsageSnapshot {
  checkedAt: string;
  month: { startISO: string; endISO: string; elapsedFraction: number };
  thresholdPct: number;
  bucketFilter: string | null;
  metrics: R2MetricAssessment[];
  /** Per-bucket storage breakdown when available (bytes). */
  buckets?: Array<{ name: string; payloadSize: number; objectCount: number }>;
  error?: string;
}

const SNAPSHOT_KEY = "r2usage:lastSnapshot";
const ALERT_STATE_KEY = "r2usage:alertState";
const LAST_CHECK_KEY = "r2usage:lastCheckAt";
const DAILY_REPORT_KEY = "r2usage:lastDailyReportAt";
const DAILY_REPORT_INTERVAL_MS = 24 * 3600_000;

export function getR2UsageSnapshot(): R2UsageSnapshot | undefined {
  try {
    return getInternalSetting<R2UsageSnapshot>(SNAPSHOT_KEY);
  } catch {
    return undefined;
  }
}

// ── Cloudflare GraphQL reads ─────────────────────────────────────────────────

const CF_GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const MAX_GRAPHQL_BYTES = 256 * 1024;

interface GraphqlDeps {
  fetchImpl?: typeof fetch;
}

async function cfGraphql<T>(
  token: string,
  query: string,
  deps: GraphqlDeps,
): Promise<T> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(CF_GRAPHQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (text.length > MAX_GRAPHQL_BYTES) throw new Error(`graphql response too large (${text.length}B)`);
  if (!res.ok) throw new Error(`graphql HTTP ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as { data?: T; errors?: Array<{ message?: string }> | null };
  if (json.errors && json.errors.length > 0) {
    throw new Error(`graphql errors: ${json.errors.map((e) => e.message ?? "?").join("; ").slice(0, 300)}`);
  }
  if (!json.data) throw new Error("graphql: no data");
  return json.data;
}

interface StorageData {
  viewer: {
    accounts: Array<{
      r2StorageAdaptiveGroups: Array<{
        max: { objectCount: number; payloadSize: number };
        dimensions: { bucketName: string; datetime: string };
      }>;
    }>;
  };
}

interface OpsData {
  viewer: {
    accounts: Array<{
      r2OperationsAdaptiveGroups: Array<{
        sum: { requests: number };
        dimensions: { actionType: string; bucketName: string };
      }>;
    }>;
  };
}

export interface R2RawUsage {
  storageBytes: number;
  objectCount: number;
  classAOps: number;
  classBOps: number;
  buckets: Array<{ name: string; payloadSize: number; objectCount: number }>;
}

export async function fetchR2RawUsage(
  accountId: string,
  token: string,
  window: R2MonthWindow,
  bucketFilter: string | null,
  deps: GraphqlDeps = {},
): Promise<R2RawUsage> {
  const bucketClause = bucketFilter ? `, bucketName: "${bucketFilter}"` : "";
  const storage = await cfGraphql<StorageData>(
    token,
    `query { viewer { accounts(filter: {accountTag: "${accountId}"}) {
      r2StorageAdaptiveGroups(limit: 500,
        filter: {datetime_geq: "${window.startISO}", datetime_lt: "${window.endISO}"${bucketClause}},
        orderBy: [datetime_DESC]) {
        max { objectCount payloadSize }
        dimensions { bucketName datetime }
      } } } }`,
    deps,
  );
  const ops = await cfGraphql<OpsData>(
    token,
    `query { viewer { accounts(filter: {accountTag: "${accountId}"}) {
      r2OperationsAdaptiveGroups(limit: 1000,
        filter: {datetime_geq: "${window.startISO}", datetime_lt: "${window.endISO}"${bucketClause}}) {
        sum { requests }
        dimensions { actionType bucketName }
      } } } }`,
    deps,
  );

  // Latest storage reading per bucket (groups are ordered newest-first).
  const buckets = new Map<string, { name: string; payloadSize: number; objectCount: number }>();
  for (const g of storage.viewer.accounts[0]?.r2StorageAdaptiveGroups ?? []) {
    const name = g.dimensions.bucketName;
    if (!buckets.has(name)) {
      buckets.set(name, { name, payloadSize: g.max.payloadSize, objectCount: g.max.objectCount });
    }
  }
  let classAOps = 0;
  let classBOps = 0;
  for (const g of ops.viewer.accounts[0]?.r2OperationsAdaptiveGroups ?? []) {
    if (classifyR2Action(g.dimensions.actionType) === "A") classAOps += g.sum.requests;
    else classBOps += g.sum.requests;
  }
  const bucketList = [...buckets.values()].sort((a, b) => b.payloadSize - a.payloadSize);
  return {
    storageBytes: bucketList.reduce((s, b) => s + b.payloadSize, 0),
    objectCount: bucketList.reduce((s, b) => s + b.objectCount, 0),
    classAOps,
    classBOps,
    buckets: bucketList,
  };
}

// ── Config + cadence ─────────────────────────────────────────────────────────

function numericEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export interface R2UsageMonitorConfig {
  token: string | null;
  accountId: string | null;
  intervalHours: number;
  thresholdPct: number;
  bucketFilter: string | null;
  /** Daily usage summary notification (owner directive 2026-08-01). Default on. */
  dailyReport: boolean;
  /** Hard kill-switch: when armed (live prod) and any metric is on pace past the
   *  threshold, write the disable marker and restart the container WITHOUT
   *  litestream so R2 usage stops growing (owner directive 2026-08-01). Default on. */
  autoDisable: boolean;
  /** Marker path on the persistent volume; coolify-prod-start.sh skips
   *  `litestream replicate` while this file exists. */
  disableMarkerPath: string;
}

export function loadR2UsageMonitorConfig(): R2UsageMonitorConfig {
  const token = process.env.CLOUDFLARE_ST_API_TOKEN?.trim() || null;
  const accountId = process.env.CLOUDFLARE_ST_ACCOUNT_ID?.trim() || null;
  return {
    token,
    accountId,
    intervalHours: numericEnv("R2_USAGE_MONITOR_INTERVAL_HOURS", 6, 1),
    thresholdPct: numericEnv("R2_USAGE_ALERT_THRESHOLD_PCT", 70, 1),
    bucketFilter: process.env.R2_USAGE_BUCKET_FILTER?.trim() || null,
    dailyReport: process.env.R2_USAGE_DAILY_REPORT !== "0",
    autoDisable: process.env.R2_USAGE_AUTO_DISABLE !== "0",
    disableMarkerPath: process.env.R2_USAGE_DISABLE_MARKER?.trim() || "/app/data/.litestream-r2-disabled",
  };
}

/** The auto-disable only arms in the live production container — never in dev, tests,
 *  or a DB_BOOTSTRAP=fresh boot (which runs no replication anyway). */
export function isR2AutoDisableArmed(cfg: R2UsageMonitorConfig): boolean {
  return cfg.autoDisable && process.env.DB_BOOTSTRAP === "live";
}

/** True while litestream replication is disabled by the kill-switch marker. */
export function isR2ReplicationDisabled(cfg: R2UsageMonitorConfig = loadR2UsageMonitorConfig()): boolean {
  try {
    return existsSync(cfg.disableMarkerPath);
  } catch {
    return false;
  }
}

export function isR2UsageCheckDue(now: number = Date.now()): boolean {
  const cfg = loadR2UsageMonitorConfig();
  if (!cfg.token || !cfg.accountId) return false;
  const intervalMs = cfg.intervalHours * 3600_000;
  const last = getInternalSetting<string>(LAST_CHECK_KEY);
  if (!last) return true;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return true;
  return now - lastMs >= intervalMs;
}

// ── The check itself ─────────────────────────────────────────────────────────

export interface R2UsageCheckResult {
  status: "ok" | "skipped" | "error";
  reason?: string;
  alertsSent?: number;
  snapshot?: R2UsageSnapshot;
}

export async function runR2UsageCheck(
  now: number = Date.now(),
  deps: GraphqlDeps & { notifyImpl?: typeof notify; exitImpl?: (code: number) => void } = {},
): Promise<R2UsageCheckResult> {
  const cfg = loadR2UsageMonitorConfig();
  if (!cfg.token || !cfg.accountId) return { status: "skipped", reason: "not_configured" };

  const window = r2MonthWindow(now);
  const raw = await fetchR2RawUsage(cfg.accountId, cfg.token, window, cfg.bucketFilter, deps);
  const metrics = assessR2Usage({
    storageBytes: raw.storageBytes,
    classAOps: raw.classAOps,
    classBOps: raw.classBOps,
    thresholdPct: cfg.thresholdPct,
    now,
  });

  const snapshot: R2UsageSnapshot = {
    checkedAt: new Date(now).toISOString(),
    month: { startISO: window.startISO, endISO: window.endISO, elapsedFraction: window.elapsedFraction },
    thresholdPct: cfg.thresholdPct,
    bucketFilter: cfg.bucketFilter,
    metrics,
    buckets: raw.buckets,
  };
  setInternalSetting(SNAPSHOT_KEY, snapshot);

  // Alert on transitions only (crossed / recovered), never on steady state.
  const prev = getInternalSetting<R2AlertState>(ALERT_STATE_KEY) ?? {};
  const transitions = r2AlertTransitions(prev, metrics);
  const next: R2AlertState = {};
  for (const m of metrics) next[m.id] = m.exceeded ? "exceeded" : "ok";
  setInternalSetting(ALERT_STATE_KEY, next);

  const notifyImpl = deps.notifyImpl ?? notify;
  let alertsSent = 0;
  for (const t of transitions) {
    const m = t.metric;
    const crossedTitle =
      m.alertBasis === "absolute"
        ? `⚠️ R2 ${m.label} at ${m.pctUsed.toFixed(0)}% of free tier`
        : `⚠️ R2 ${m.label} on pace to exceed ${cfg.thresholdPct}% of free tier`;
    const title =
      t.direction === "crossed"
        ? crossedTitle
        : `✅ R2 ${m.label} back under ${cfg.thresholdPct}% ${m.alertBasis === "pace" ? "pace" : "usage"}`;
    const body =
      `${m.label}: ${formatR2MetricValue(m)} used month-to-date (${m.pctUsed.toFixed(1)}% of the free tier).\n` +
      (m.alertBasis === "pace"
        ? `Projected month-end: ${formatR2Projected(m)} (${m.projectedPct.toFixed(1)}%).\n`
        : `Storage alerts on absolute usage, not pace — current level is what matters.\n`) +
      `Free tier limit: ${m.unit === "bytes" ? "10 GiB" : m.limit.toLocaleString("en-US")} — alert threshold ${cfg.thresholdPct}%.\n` +
      (t.direction === "crossed"
        ? `Review litestream/upload activity on the socratic-trade-bucket (SocraticTrade.com Cloudflare account) before paid usage kicks in.`
        : `Usage is back inside the free-tier threshold.`);
    try {
      await notifyImpl("local", { title, body, kind: "r2-usage" });
      alertsSent += 1;
    } catch (err) {
      console.error("[r2-usage] notify error:", err);
    }
  }

  // Daily usage summary (owner directive 2026-08-01): a standing once-a-day report of
  // month-to-date usage + month-end projection for every metric, independent of the
  // threshold-transition alerts above, so the owner always knows where the free tier stands.
  let dailyReportSent = false;
  if (cfg.dailyReport) {
    const lastReport = getInternalSetting<string>(DAILY_REPORT_KEY);
    const lastReportMs = lastReport ? Date.parse(lastReport) : Number.NaN;
    if (!Number.isFinite(lastReportMs) || now - lastReportMs >= DAILY_REPORT_INTERVAL_MS) {
      setInternalSetting(DAILY_REPORT_KEY, new Date(now).toISOString());
      const lines = metrics.map(
        (m) =>
          `${m.label}: ${formatR2MetricValue(m)} MTD (${m.pctUsed.toFixed(1)}% of free tier) — ` +
          `projected ${formatR2Projected(m)} (${m.projectedPct.toFixed(1)}%)`
      );
      try {
        await notifyImpl("local", {
          title: `R2 free-tier daily usage report`,
          body:
            `Month-to-date vs the Cloudflare R2 free tier (10 GiB storage, 1M Class A ops, 10M Class B ops):\n` +
            lines.join("\n") +
            `\nAlert/auto-disable threshold: ${cfg.thresholdPct}% projected month-end.` +
            (isR2ReplicationDisabled(cfg)
              ? `\nLitestream replication is currently DISABLED by the kill-switch marker.`
              : ""),
          kind: "r2-usage",
        });
        dailyReportSent = true;
      } catch (err) {
        console.error("[r2-usage] daily report notify error:", err);
      }
    }
  }

  // Hard kill-switch (owner directive 2026-08-01): when armed (live prod only) and any metric
  // is on pace past the threshold, STOP consuming R2 — write the persistent disable marker
  // (coolify-prod-start.sh boots without `litestream replicate` while it exists) and restart
  // the container so replication actually halts. Stays off until the owner decides what to do
  // and resumes via POST /api/admin/r2-usage/resume (or by deleting the marker + restarting).
  const exceededMetrics = metrics.filter((m) => m.exceeded);
  let autoDisabled = false;
  if (exceededMetrics.length > 0 && isR2AutoDisableArmed(cfg) && !isR2ReplicationDisabled(cfg)) {
    const markerPayload = {
      disabledAt: new Date(now).toISOString(),
      reason: `on pace to exceed ${cfg.thresholdPct}% of the R2 free tier`,
      thresholdPct: cfg.thresholdPct,
      exceeded: exceededMetrics.map((m) => ({
        id: m.id,
        mtd: m.mtd,
        projectedPct: Number(m.projectedPct.toFixed(2)),
      })),
      resume: "POST /api/admin/r2-usage/resume (admin) or delete this file and restart the container",
    };
    try {
      writeFileSync(cfg.disableMarkerPath, JSON.stringify(markerPayload, null, 2));
      audit("r2_usage.auto_disabled", markerPayload);
      try {
        await notifyImpl("local", {
          title: `🛑 R2 free-tier kill-switch: litestream replication auto-disabled`,
          body:
            `On pace to exceed ${cfg.thresholdPct}% of the R2 free tier:\n` +
            exceededMetrics
              .map((m) => `${m.label}: projected ${formatR2Projected(m)} (${m.projectedPct.toFixed(1)}% of free tier)`)
              .join("\n") +
            `\n\nReplication is OFF (container restarting without litestream) and stays off until you resume it: ` +
            `POST /api/admin/r2-usage/resume or delete ${cfg.disableMarkerPath} and restart. ` +
            `Note: PITR backups to R2 are paused while disabled.`,
          kind: "r2-usage",
        });
      } catch (err) {
        console.error("[r2-usage] auto-disable notify error:", err);
      }
      autoDisabled = true;
    } catch (err) {
      console.error("[r2-usage] failed to write disable marker:", err);
      try {
        audit("r2_usage.auto_disable_failed", { error: err instanceof Error ? err.message : String(err) });
      } catch { /* never throw */ }
    }
  }

  audit("r2_usage.check", {
    storageBytes: raw.storageBytes,
    classAOps: raw.classAOps,
    classBOps: raw.classBOps,
    elapsedFraction: Number(window.elapsedFraction.toFixed(4)),
    exceeded: metrics.filter((m) => m.exceeded).map((m) => m.id),
    alertsSent,
    dailyReportSent,
    autoDisabled,
  });

  if (autoDisabled) {
    // Restart the container so the start script re-boots WITHOUT litestream. notify() was
    // awaited above, so delivery already happened; exit code is arbitrary (Coolify restarts).
    const exitImpl = deps.exitImpl ?? ((code: number) => process.exit(code));
    exitImpl(41);
  }
  return { status: "ok", alertsSent, snapshot };
}

/**
 * Re-enable litestream replication after an auto-disable: remove the kill-switch marker and
 * restart the container (the start script boots under `litestream replicate` again). The
 * process exit means the HTTP caller may see a connection reset — the resume still happened.
 */
export async function resumeR2Replication(
  deps: { exitImpl?: (code: number) => void } = {},
): Promise<{ resumed: boolean; reason?: string }> {
  const cfg = loadR2UsageMonitorConfig();
  if (!isR2ReplicationDisabled(cfg)) return { resumed: false, reason: "not_disabled" };
  try {
    unlinkSync(cfg.disableMarkerPath);
  } catch (err) {
    return { resumed: false, reason: err instanceof Error ? err.message : String(err) };
  }
  audit("r2_usage.resumed", { marker: cfg.disableMarkerPath });
  const exitImpl = deps.exitImpl ?? ((code: number) => process.exit(code));
  exitImpl(42);
  return { resumed: true };
}

/** Cadence-gated scheduler entrypoint. Watermark-first so a busy tick loop
 *  can't double-run; self-guarded so it can never break the trading tick. */
export async function runR2UsageCheckIfDue(now: number = Date.now()): Promise<void> {
  try {
    if (!isR2UsageCheckDue(now)) return;
    setInternalSetting(LAST_CHECK_KEY, new Date(now).toISOString());
    await runR2UsageCheck(now);
  } catch (err) {
    console.error("[r2-usage] usage check error:", err);
    try {
      audit("r2_usage.check_error", { error: err instanceof Error ? err.message : String(err) });
    } catch {
      /* never throw */
    }
  }
}

// ── Daily digest (owner opt-in 2026-07-31): a Pushover/notify summary of
// free-tier consumption + pace every day, whether or not anything crossed. ──

const LAST_DIGEST_KEY = "r2usage:lastDigestAt";

export function r2UsageDigestEnabled(): boolean {
  const raw = process.env.R2_USAGE_DAILY_DIGEST?.trim().toLowerCase();
  // Default ON when the monitor is configured; explicit off/false/0/no disables.
  return !(raw === "off" || raw === "false" || raw === "0" || raw === "no");
}

export function isR2UsageDigestDue(now: number = Date.now()): boolean {
  const cfg = loadR2UsageMonitorConfig();
  if (!cfg.token || !cfg.accountId || !r2UsageDigestEnabled()) return false;
  const intervalMs = numericEnv("R2_USAGE_DIGEST_INTERVAL_HOURS", 24, 1) * 3600_000;
  const last = getInternalSetting<string>(LAST_DIGEST_KEY);
  if (!last) return true;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return true;
  return now - lastMs >= intervalMs;
}

/** Compose the digest message from a snapshot. Exported for tests. */
export function buildR2UsageDigestMessage(
  snapshot: R2UsageSnapshot,
): { title: string; body: string } {
  const day = snapshot.checkedAt.slice(0, 10);
  const anyExceeded = snapshot.metrics.some((m) => m.exceeded);
  const title = anyExceeded
    ? `📊 R2 free-tier daily — ${day} — ⚠️ over ${snapshot.thresholdPct}% pace`
    : `📊 R2 free-tier daily — ${day}`;
  const lines = snapshot.metrics.map((m) => {
    const flag = m.exceeded ? " ⚠️" : " ✓";
    return (
      `${m.label}: ${formatR2MetricValue(m)} MTD (${m.pctUsed.toFixed(1)}%)` +
      ` → pace ${m.projectedPct.toFixed(0)}% by month end${flag}`
    );
  });
  const body =
    lines.join("\n") +
    `\n\nFree tier: 10 GiB storage / 1M Class A / 10M Class B ops per month.` +
    ` Alert threshold: ${snapshot.thresholdPct}% pace.` +
    (snapshot.bucketFilter ? ` Bucket: ${snapshot.bucketFilter}.` : " Scope: whole account.") +
    `\nChecked: ${snapshot.checkedAt}`;
  return { title, body };
}

export interface R2UsageDigestResult {
  status: "sent" | "skipped" | "error";
  reason?: string;
}

/** Runs a FRESH usage check (so the digest is never stale), then notifies the
 *  summary. Self-guarded; watermark-first. */
export async function runR2UsageDailyDigestIfDue(
  now: number = Date.now(),
  deps: GraphqlDeps & { notifyImpl?: typeof notify } = {},
): Promise<R2UsageDigestResult> {
  try {
    if (!isR2UsageDigestDue(now)) return { status: "skipped", reason: "not_due" };
    setInternalSetting(LAST_DIGEST_KEY, new Date(now).toISOString());
    const check = await runR2UsageCheck(now, deps);
    if (check.status !== "ok" || !check.snapshot) {
      return { status: "skipped", reason: check.reason ?? "check_failed" };
    }
    const { title, body } = buildR2UsageDigestMessage(check.snapshot);
    const notifyImpl = deps.notifyImpl ?? notify;
    await notifyImpl("local", { title, body, kind: "r2-usage-digest" });
    audit("r2_usage.digest", {
      exceeded: check.snapshot.metrics.filter((m) => m.exceeded).map((m) => m.id),
    });
    return { status: "sent" };
  } catch (err) {
    console.error("[r2-usage] daily digest error:", err);
    try {
      audit("r2_usage.digest_error", { error: err instanceof Error ? err.message : String(err) });
    } catch {
      /* never throw */
    }
    return { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}
