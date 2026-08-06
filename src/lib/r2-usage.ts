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
/** Keyed per metric within pure helpers; the persisted store keys are
 *  `account:metric` composites (three accounts track independently). */
export type R2AlertState = Record<string, R2AlertLevel>;

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
  /** Which Cloudflare account this snapshot covers (each has its own free tier). */
  accountId: string;
  accountLabel: string;
  checkedAt: string;
  month: { startISO: string; endISO: string; elapsedFraction: number };
  thresholdPct: number;
  bucketFilter: string | null;
  metrics: R2MetricAssessment[];
  /** Per-bucket storage breakdown when available (bytes). */
  buckets?: Array<{ name: string; payloadSize: number; objectCount: number }>;
  error?: string;
}

const SNAPSHOTS_KEY = "r2usage:lastSnapshots";
const ALERT_STATE_KEY = "r2usage:alertState";
const LAST_CHECK_KEY = "r2usage:lastCheckAt";

/** All per-account snapshots from the latest check (empty before the first run). */
export function getR2UsageSnapshots(): R2UsageSnapshot[] {
  try {
    const v = getInternalSetting<R2UsageSnapshot[]>(SNAPSHOTS_KEY);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
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

/**
 * The fleet uses THREE Cloudflare accounts (owner directive 2026-08-01), each
 * with its own independent R2 free tier (10 GiB / 1M A / 10M B per account):
 *   st — Socratic Trade  (socratic-trade-bucket)
 *   ct — Congress.Trade     (congress-trade-bucket)
 *   um — Usage.Jays.Services (usage-monitor-receipts)
 * Each slot is configured by an env pair; every configured slot is monitored.
 * Unset slots are skipped, so a subset works fine.
 */
export interface R2UsageAccountConfig {
  id: "st" | "ct" | "um";
  label: string;
  accountId: string;
  token: string;
}

export function loadR2UsageAccounts(): R2UsageAccountConfig[] {
  const slots: Array<{ id: "st" | "ct" | "um"; label: string; tokenEnv: string; accountEnv: string }> = [
    { id: "st", label: "Socratic Trade", tokenEnv: "CLOUDFLARE_ST_API_TOKEN", accountEnv: "CLOUDFLARE_ST_ACCOUNT_ID" },
    { id: "ct", label: "Congress.Trade", tokenEnv: "CLOUDFLARE_CT_API_TOKEN", accountEnv: "CLOUDFLARE_CT_ACCOUNT_ID" },
    { id: "um", label: "Usage Monitor", tokenEnv: "CLOUDFLARE_JAY_API_TOKEN", accountEnv: "CLOUDFLARE_JAY_ACCOUNT_ID" },
  ];
  const out: R2UsageAccountConfig[] = [];
  for (const s of slots) {
    const token = process.env[s.tokenEnv]?.trim();
    const accountId = process.env[s.accountEnv]?.trim();
    if (token && accountId) out.push({ id: s.id, label: s.label, accountId, token });
  }
  return out;
}

export interface R2UsageMonitorConfig {
  intervalHours: number;
  thresholdPct: number;
  bucketFilter: string | null;
  /** Hard kill-switch: when armed (live prod) and any metric is on pace past the
   *  threshold, write the disable marker and restart the container WITHOUT
   *  litestream so R2 usage stops growing (owner directive 2026-08-01). Default on. */
  autoDisable: boolean;
  /** Marker path on the persistent volume; coolify-prod-start.sh skips
   *  `litestream replicate` while this file exists. */
  disableMarkerPath: string;
}

export function loadR2UsageMonitorConfig(): R2UsageMonitorConfig {
  return {
    intervalHours: numericEnv("R2_USAGE_MONITOR_INTERVAL_HOURS", 6, 1),
    thresholdPct: numericEnv("R2_USAGE_ALERT_THRESHOLD_PCT", 70, 1),
    bucketFilter: process.env.R2_USAGE_BUCKET_FILTER?.trim() || null,
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
  if (loadR2UsageAccounts().length === 0) return false;
  const intervalMs = cfg.intervalHours * 3600_000;
  const last = getInternalSetting<string>(LAST_CHECK_KEY);
  if (!last) return true;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return true;
  return now - lastMs >= intervalMs;
}

// ── The check itself ─────────────────────────────────────────────────────────

export interface R2AccountCheckResult {
  accountId: string;
  accountLabel: string;
  status: "ok" | "error";
  error?: string;
  alertsSent: number;
  snapshot?: R2UsageSnapshot;
}

export interface R2UsageCheckResult {
  status: "ok" | "skipped" | "partial" | "error";
  reason?: string;
  alertsSent: number;
  snapshots: R2UsageSnapshot[];
  results: R2AccountCheckResult[];
}

async function checkOneAccount(
  account: R2UsageAccountConfig,
  window: R2MonthWindow,
  cfg: R2UsageMonitorConfig,
  now: number,
  prev: R2AlertState,
  next: R2AlertState,
  notifyImpl: typeof notify,
  deps: GraphqlDeps,
): Promise<R2AccountCheckResult> {
  const raw = await fetchR2RawUsage(account.accountId, account.token, window, cfg.bucketFilter, deps);
  const metrics = assessR2Usage({
    storageBytes: raw.storageBytes,
    classAOps: raw.classAOps,
    classBOps: raw.classBOps,
    thresholdPct: cfg.thresholdPct,
    now,
  });

  const snapshot: R2UsageSnapshot = {
    accountId: account.accountId,
    accountLabel: account.label,
    checkedAt: new Date(now).toISOString(),
    month: { startISO: window.startISO, endISO: window.endISO, elapsedFraction: window.elapsedFraction },
    thresholdPct: cfg.thresholdPct,
    bucketFilter: cfg.bucketFilter,
    metrics,
    buckets: raw.buckets,
  };

  // Alert on transitions only (crossed / recovered), never on steady state.
  // State keys are per account+metric so the three free tiers track independently.
  const transitions = r2AlertTransitionsKeyed(account.id, prev, metrics);
  for (const m of metrics) next[`${account.id}:${m.id}`] = m.exceeded ? "exceeded" : "ok";

  let alertsSent = 0;
  for (const t of transitions) {
    const m = t.metric;
    const crossedTitle =
      m.alertBasis === "absolute"
        ? `⚠️ R2 ${m.label} at ${m.pctUsed.toFixed(0)}% of free tier (${account.label})`
        : `⚠️ R2 ${m.label} on pace to exceed ${cfg.thresholdPct}% of free tier (${account.label})`;
    const title =
      t.direction === "crossed"
        ? crossedTitle
        : `✅ R2 ${m.label} back under ${cfg.thresholdPct}% ${m.alertBasis === "pace" ? "pace" : "usage"} (${account.label})`;
    const body =
      `Account: ${account.label} (${account.accountId})\n` +
      `${m.label}: ${formatR2MetricValue(m)} used month-to-date (${m.pctUsed.toFixed(1)}% of the free tier).\n` +
      (m.alertBasis === "pace"
        ? `Projected month-end: ${formatR2Projected(m)} (${m.projectedPct.toFixed(1)}%).\n`
        : `Storage alerts on absolute usage, not pace — current level is what matters.\n`) +
      `Free tier limit: ${m.unit === "bytes" ? "10 GiB" : m.limit.toLocaleString("en-US")} — alert threshold ${cfg.thresholdPct}%.\n` +
      (t.direction === "crossed"
        ? `Review litestream/upload activity on this Cloudflare account before paid usage kicks in.`
        : `Usage is back inside the free-tier threshold.`);
    try {
      await notifyImpl("local", { title, body, kind: "r2-usage" });
      alertsSent += 1;
    } catch (err) {
      console.error("[r2-usage] notify error:", err);
    }
  }

  // Daily summary is the multi-account digest (runR2UsageDailyDigestIfDue), not per-account
  // spam; the auto-disable kill-switch is evaluated once per RUN for the "st" account only
  // (see runR2UsageCheck) — a ct/um account's usage must never stop THIS app's litestream.

  audit("r2_usage.check", {
    account: account.id,
    storageBytes: raw.storageBytes,
    classAOps: raw.classAOps,
    classBOps: raw.classBOps,
    elapsedFraction: Number(window.elapsedFraction.toFixed(4)),
    exceeded: metrics.filter((m) => m.exceeded).map((m) => m.id),
    alertsSent,
  });
  return { accountId: account.accountId, accountLabel: account.label, status: "ok", alertsSent, snapshot };
}

/** Per-account-keyed variant of r2AlertTransitions. */
function r2AlertTransitionsKeyed(
  accountKey: string,
  prev: R2AlertState,
  metrics: readonly R2MetricAssessment[],
): R2AlertTransition[] {
  const scopedPrev: R2AlertState = {};
  for (const m of metrics) scopedPrev[m.id] = prev[`${accountKey}:${m.id}`];
  return r2AlertTransitions(scopedPrev, metrics);
}

export async function runR2UsageCheck(
  now: number = Date.now(),
  deps: GraphqlDeps & { notifyImpl?: typeof notify; exitImpl?: (code: number) => void } = {},
): Promise<R2UsageCheckResult> {
  const cfg = loadR2UsageMonitorConfig();
  const accounts = loadR2UsageAccounts();
  if (accounts.length === 0) {
    return { status: "skipped", reason: "not_configured", alertsSent: 0, snapshots: [], results: [] };
  }

  const window = r2MonthWindow(now);
  const notifyImpl = deps.notifyImpl ?? notify;
  const prev = getInternalSetting<R2AlertState>(ALERT_STATE_KEY) ?? {};
  const next: R2AlertState = { ...prev };
  const results: R2AccountCheckResult[] = [];

  for (const account of accounts) {
    try {
      results.push(await checkOneAccount(account, window, cfg, now, prev, next, notifyImpl, deps));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[r2-usage] check failed for ${account.id}:`, err);
      audit("r2_usage.check_error", { account: account.id, error: msg });
      results.push({ accountId: account.accountId, accountLabel: account.label, status: "error", error: msg, alertsSent: 0 });
    }
  }

  setInternalSetting(ALERT_STATE_KEY, next);
  const snapshots = results.filter((r) => r.snapshot).map((r) => r.snapshot!);
  setInternalSetting(SNAPSHOTS_KEY, snapshots);
  const alertsSent = results.reduce((s, r) => s + r.alertsSent, 0);
  const errors = results.filter((r) => r.status === "error").length;

  // Hard kill-switch (owner directive 2026-08-01), scoped to the "st" account ONLY — that is
  // the Cloudflare account THIS app's litestream writes to; ct/um usage must never stop our
  // replication. When armed (live prod boot) and any st metric is over its alert basis, write
  // the persistent disable marker (coolify-prod-start.sh boots without `litestream replicate`
  // while it exists) and restart the container so replication actually halts. Stays off until
  // the owner resumes via POST /api/admin/r2-usage/resume (or deletes the marker + restarts).
  // State writes above already landed, so the post-restart check can't double-fire.
  const stResult = results.find((r) => r.snapshot && accounts.find((a) => a.accountId === r.accountId)?.id === "st");
  const exceededMetrics = (stResult?.snapshot?.metrics ?? []).filter((m) => m.exceeded);
  if (exceededMetrics.length > 0 && isR2AutoDisableArmed(cfg) && !isR2ReplicationDisabled(cfg)) {
    const markerPayload = {
      disabledAt: new Date(now).toISOString(),
      reason: `Socratic Trade R2 account over ${cfg.thresholdPct}% free-tier threshold`,
      thresholdPct: cfg.thresholdPct,
      exceeded: exceededMetrics.map((m) => ({
        id: m.id,
        mtd: m.mtd,
        pctUsed: Number(m.pctUsed.toFixed(2)),
        projectedPct: Number(m.projectedPct.toFixed(2)),
        alertBasis: m.alertBasis,
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
            `The Socratic Trade Cloudflare account crossed the ${cfg.thresholdPct}% free-tier threshold:\n` +
            exceededMetrics
              .map((m) => `${m.label}: ${m.alertBasis === "pace" ? `projected ${formatR2Projected(m)} (${m.projectedPct.toFixed(1)}%)` : `${formatR2MetricValue(m)} (${m.pctUsed.toFixed(1)}%)`}`)
              .join("\n") +
            `\n\nReplication is OFF (container restarting without litestream) and stays off until you resume it: ` +
            `POST /api/admin/r2-usage/resume or delete ${cfg.disableMarkerPath} and restart. ` +
            `Note: PITR backups to R2 are paused while disabled.`,
          kind: "r2-usage",
        });
      } catch (err) {
        console.error("[r2-usage] auto-disable notify error:", err);
      }
      // Restart the container so the start script re-boots WITHOUT litestream. notify() was
      // awaited above, so delivery already happened; exit code is arbitrary (Coolify restarts).
      const exitImpl = deps.exitImpl ?? ((code: number) => process.exit(code));
      exitImpl(41);
    } catch (err) {
      console.error("[r2-usage] failed to write disable marker:", err);
      try {
        audit("r2_usage.auto_disable_failed", { error: err instanceof Error ? err.message : String(err) });
      } catch { /* never throw */ }
    }
  }

  return {
    status: errors === 0 ? "ok" : errors === results.length ? "error" : "partial",
    alertsSent,
    snapshots,
    results,
  };
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
  if (loadR2UsageAccounts().length === 0 || !r2UsageDigestEnabled()) return false;
  const intervalMs = numericEnv("R2_USAGE_DIGEST_INTERVAL_HOURS", 24, 1) * 3600_000;
  const last = getInternalSetting<string>(LAST_DIGEST_KEY);
  if (!last) return true;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return true;
  return now - lastMs >= intervalMs;
}

/** Compose the digest message from the per-account snapshots. Exported for tests. */
export function buildR2UsageDigestMessage(
  snapshots: R2UsageSnapshot[],
): { title: string; body: string } {
  const day = (snapshots[0]?.checkedAt ?? new Date().toISOString()).slice(0, 10);
  const anyExceeded = snapshots.some((s) => s.metrics.some((m) => m.exceeded));
  const title = anyExceeded
    ? `📊 R2 free-tier daily — ${day} — ⚠️ over threshold`
    : `📊 R2 free-tier daily — ${day}`;
  const sections = snapshots.map((s) => {
    const lines = s.metrics.map((m) => {
      const flag = m.exceeded ? " ⚠️" : " ✓";
      const pace = m.alertBasis === "pace" ? ` → pace ${m.projectedPct.toFixed(0)}%` : "";
      return `  ${m.label}: ${formatR2MetricValue(m)} MTD (${m.pctUsed.toFixed(1)}%)${pace}${flag}`;
    });
    return `${s.accountLabel}\n${lines.join("\n")}`;
  });
  const thresholdPct = snapshots[0]?.thresholdPct ?? 70;
  const body =
    sections.join("\n\n") +
    `\n\nFree tier per account: 10 GiB storage / 1M Class A / 10M Class B ops per month.` +
    ` Alert threshold: ${thresholdPct}%.` +
    `\nChecked: ${snapshots[0]?.checkedAt ?? "never"}`;
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
    if (check.snapshots.length === 0) {
      return { status: "skipped", reason: check.reason ?? "check_failed" };
    }
    const { title, body } = buildR2UsageDigestMessage(check.snapshots);
    const notifyImpl = deps.notifyImpl ?? notify;
    await notifyImpl("local", { title, body, kind: "r2-usage-digest" });
    audit("r2_usage.digest", {
      accounts: check.snapshots.map((s) => s.accountId),
      exceeded: check.snapshots.flatMap((s) => s.metrics.filter((m) => m.exceeded).map((m) => `${s.accountLabel}:${m.id}`)),
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
