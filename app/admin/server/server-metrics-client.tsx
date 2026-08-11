"use client";

import { useEffect, useState, useCallback } from "react";
import { Btn, Card, Chip, Dot, Meter, Toggle } from "../../console/ui/primitives";
import { Server, Cpu, Database, Activity, RefreshCw, Layers, ArrowDown, ArrowUp, Globe, Shield, HardDrive } from "lucide-react";
import { asRecord, normalizeCoolifyResources, readText } from "@/lib/server-metrics-shapes";

interface MetricPoint {
  timestamp: number;
  value: number;
}

interface HostInfo {
  // JSON is an untrusted runtime boundary. Keep every display field unknown so
  // a future provider regression renders a diagnostic rather than crashing.
  name?: unknown;
  status?: unknown;
  os?: unknown;
  cpus?: unknown;
  memoryTotalBytes?: unknown;
  memoryFreeBytes?: unknown;
  diskTotalBytes?: unknown;
  diskFreeBytes?: unknown;
  diskUsedBytes?: unknown;
  diskUsedPct?: unknown;
  uptimeSeconds?: unknown;
  loadAvg?: unknown;
  serverType?: unknown;
  location?: unknown;
  ip?: unknown;
}

interface ServerMetricsData {
  isProd: boolean;
  usesLocalHost?: boolean;
  degraded?: boolean;
  stale?: boolean;
  cacheAgeSeconds?: number;
  hostInfo: HostInfo;
  resources: unknown;
  metrics: {
    cpu: MetricPoint[];
    diskRead: MetricPoint[];
    diskWrite: MetricPoint[];
    networkRx: MetricPoint[];
    networkTx: MetricPoint[];
  };
  asOf: string;
  error?: string;
  warnings?: unknown;
}

function parseMetricPoints(value: unknown): MetricPoint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const points: MetricPoint[] = [];
  for (const item of value) {
    const point = asRecord(item);
    if (
      typeof point?.timestamp !== "number"
      || !Number.isFinite(point.timestamp)
      || typeof point.value !== "number"
      || !Number.isFinite(point.value)
    ) return undefined;
    points.push({ timestamp: point.timestamp, value: point.value });
  }
  return points;
}

export function parseServerMetricsEnvelope(value: unknown): ServerMetricsData | undefined {
  const envelope = asRecord(value);
  const hostInfo = asRecord(envelope?.hostInfo);
  const rawMetrics = asRecord(envelope?.metrics);
  if (
    typeof envelope?.isProd !== "boolean"
    || !hostInfo
    || !Array.isArray(envelope.resources)
    || !rawMetrics
    || typeof envelope.asOf !== "string"
    || !Number.isFinite(Date.parse(envelope.asOf))
  ) return undefined;
  const cpu = parseMetricPoints(rawMetrics.cpu);
  const diskRead = parseMetricPoints(rawMetrics.diskRead);
  const diskWrite = parseMetricPoints(rawMetrics.diskWrite);
  const networkRx = parseMetricPoints(rawMetrics.networkRx);
  const networkTx = parseMetricPoints(rawMetrics.networkTx);
  if (!cpu || !diskRead || !diskWrite || !networkRx || !networkTx) return undefined;
  return {
    isProd: envelope.isProd,
    usesLocalHost: envelope.usesLocalHost === true,
    degraded: envelope.degraded === true,
    stale: envelope.stale === true,
    cacheAgeSeconds: readNonNegativeNumber(envelope.cacheAgeSeconds),
    hostInfo,
    resources: envelope.resources,
    metrics: { cpu, diskRead, diskWrite, networkRx, networkTx },
    asOf: envelope.asOf,
    error: readText(envelope.error),
    warnings: envelope.warnings,
  };
}

export function markServerMetricsSnapshotStale(
  previous: ServerMetricsData | null,
  error: string,
): ServerMetricsData | null {
  return previous ? { ...previous, degraded: true, stale: true, error } : null;
}

// Helper formats
function formatBytes(bytes: number, decimals = 1) {
  if (bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + " " + sizes[i];
}

function formatBandwidth(bytesPerSec: number) {
  if (bytesPerSec <= 0) return "0 B/s";
  const k = 1024;
  const sizes = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
  return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatUptime(seconds: number) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  return `${h}h ${m}m`;
}

export function displayProviderText(value: unknown, fallback: string, label: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value === undefined || value === null || value === "") return fallback;
  return `Invalid ${label}`;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function ServerMetricsClient() {
  const [data, setData] = useState<ServerMetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoPoll, setAutoPoll] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/server-metrics");
      const json: unknown = await res.json().catch(() => undefined);
      const envelope = parseServerMetricsEnvelope(json);
      if (res.ok) {
        if (envelope) {
          setData(envelope);
          setRequestError(null);
        } else {
          const error = "The server metrics endpoint returned malformed data.";
          setData((previous) => markServerMetricsSnapshotStale(previous, error));
          setRequestError(error);
        }
      } else {
        const error = readText(asRecord(json)?.error) || "Failed to load metrics";
        // Preserve verified partial data if a proxy or unexpected route error
        // changes the status code; reject unrelated/malformed error JSON.
        if (envelope) {
          setData({ ...envelope, error });
          setRequestError(null);
        } else {
          setData((previous) => markServerMetricsSnapshotStale(previous, error));
          setRequestError(error);
        }
      }
    } catch (err) {
      console.error(err);
      const error = "Unable to reach the server metrics endpoint.";
      setData((previous) => markServerMetricsSnapshotStale(previous, error));
      setRequestError(error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchMetrics();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchMetrics]);

  useEffect(() => {
    if (!autoPoll) return;
    const timer = setInterval(() => {
      void fetchMetrics();
    }, 30000);
    return () => clearInterval(timer);
  }, [autoPoll, fetchMetrics]);

  if (loading) {
    return (
      <div className="flex h-[50vh] flex-col items-center justify-center gap-3">
        <RefreshCw className="h-8 w-8 animate-spin text-[color:var(--con-accent)]" />
        <span className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">Polling infrastructure health...</span>
      </div>
    );
  }

  const host = data?.hostInfo;
  const normalizedResources = normalizeCoolifyResources(data?.resources ?? []);
  const resources = normalizedResources.resources;
  const metrics = data?.metrics;
  const providerWarnings = Array.isArray(data?.warnings)
    ? data.warnings.filter((warning): warning is string => typeof warning === "string" && Boolean(warning.trim()))
    : data?.warnings == null
      ? []
      : ["The server metrics warnings payload was malformed."];
  const warnings = [...providerWarnings, ...normalizedResources.warnings];
  const usesLocalHost = data?.usesLocalHost === true;
  const hostName = displayProviderText(host?.name, usesLocalHost ? "localhost" : "Unavailable", "host name");
  const hostOs = displayProviderText(host?.os, "Unavailable", "operating system");
  const hostIp = displayProviderText(host?.ip, usesLocalHost ? "127.0.0.1" : "Unavailable", "server IP");
  const hostLocation = displayProviderText(host?.location, usesLocalHost ? "local" : "Unavailable", "server location");
  const serverType = displayProviderText(host?.serverType, usesLocalHost ? "local runtime" : "Unavailable", "server type");
  const cpuCores = typeof host?.cpus === "number" && Number.isFinite(host.cpus) && host.cpus > 0
    ? `${host.cpus} Cores`
    : "Unavailable";
  const memoryTotalBytes = readNonNegativeNumber(host?.memoryTotalBytes);
  const memoryFreeBytes = readNonNegativeNumber(host?.memoryFreeBytes);
  const memPct = memoryTotalBytes && memoryFreeBytes !== undefined
    ? Math.max(0, Math.min(100, Math.round(((memoryTotalBytes - memoryFreeBytes) / memoryTotalBytes) * 100)))
    : undefined;
  const diskTotalBytes = readNonNegativeNumber(host?.diskTotalBytes);
  const diskFreeBytes = readNonNegativeNumber(host?.diskFreeBytes);
  const diskUsedBytes = readNonNegativeNumber(host?.diskUsedBytes);
  const diskUsedPct = typeof host?.diskUsedPct === "number" && Number.isFinite(host.diskUsedPct)
    ? Math.max(0, Math.min(100, Math.round(host.diskUsedPct)))
    : undefined;
  const uptimeSeconds = readNonNegativeNumber(host?.uptimeSeconds);
  const loadAverage = Array.isArray(host?.loadAvg)
    ? readNonNegativeNumber(host.loadAvg[0])
    : undefined;
  const asOf = data?.asOf ? new Date(data.asOf) : undefined;
  const hasValidAsOf = asOf && Number.isFinite(asOf.getTime());
  const formattedAsOf = hasValidAsOf ? asOf.toLocaleString(undefined, { timeZone: "America/Chicago" }) : "Unavailable";

  // CPU average of last 3 points
  const latestCpuValues = metrics?.cpu?.slice(-3).map(p => p.value) || [];
  const currentCpu = latestCpuValues.length > 0
    ? Math.round(latestCpuValues.reduce((a, b) => a + b, 0) / latestCpuValues.length)
    : undefined;

  // Disk/Network average speed of last 3 points
  const getLatestAvg = (points?: MetricPoint[]) => {
    const vals = points?.slice(-3).map(p => p.value) || [];
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
  };

  const currentDiskRead = getLatestAvg(metrics?.diskRead);
  const currentDiskWrite = getLatestAvg(metrics?.diskWrite);
  const currentNetRx = getLatestAvg(metrics?.networkRx);
  const currentNetTx = getLatestAvg(metrics?.networkTx);

  return (
    <div className="space-y-6">
      {/* Header Info */}
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">Server Stats</h1>
            {usesLocalHost ? (
              <Chip tone="warn">LOCAL HOST</Chip>
            ) : (
              <Chip tone={data?.degraded ? "warn" : "accent"}>
                {data?.isProd
                  ? data.degraded ? "PRODUCTION - DEGRADED" : "PRODUCTION"
                  : data?.degraded ? "REMOTE - DEGRADED" : "REMOTE"}
              </Chip>
            )}
            {data?.stale && <Chip tone="warn">STALE SNAPSHOT</Chip>}
          </div>
          <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            Host node metrics and application resource statuses.
          </p>
          <p className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
            As of {formattedAsOf}
            {typeof data?.cacheAgeSeconds === "number" && data.cacheAgeSeconds > 0
              ? ` (${Math.floor(data.cacheAgeSeconds)}s old)`
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-3 self-start max-sm:w-full">
          <div className="flex items-center gap-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)] max-sm:mr-auto">
            <Toggle checked={autoPoll} onChange={setAutoPoll} label="Auto-refresh every 30 seconds" />
            Auto-refresh (30s)
          </div>
          <Btn
            variant="outline"
            size="sm"
            onClick={() => {
              setRefreshing(true);
              void fetchMetrics();
            }}
            disabled={refreshing}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Btn>
        </div>
      </header>

      {(requestError || data?.error) && (
        <div className="rounded-[var(--con-radius-sm)] border border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] p-4 text-[length:var(--con-fs-sm)] text-[color:var(--con-neg)]">
          <span className="font-semibold">Error retrieving full metrics:</span> {requestError || data?.error}
          {data ? " Available verified data is shown." : ""}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="rounded-[var(--con-radius-sm)] border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] p-4 text-[length:var(--con-fs-sm)] text-[color:var(--con-warn)]" role="status">
          <span className="font-semibold">Provider metadata warning:</span> {warnings.join(" ")}
        </div>
      )}

      {/* Host Details Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card>
          <div className="flex items-center gap-3">
            <div className="rounded-[var(--con-radius-sm)] bg-[color:var(--con-accent-soft)] p-2 text-[color:var(--con-accent)]">
              <Server size={20} />
            </div>
            <div>
              <div className="con-card-title">Host Server</div>
              <div className="font-bold">{hostName}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                <Globe size={11} /> {hostIp} • {hostLocation}
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-3">
            <div className="rounded-[var(--con-radius-sm)] bg-[color:var(--con-pos-soft)] p-2 text-[color:var(--con-pos)]">
              <Cpu size={20} />
            </div>
            <div>
              <div className="con-card-title">CPU Cores</div>
              <div className="font-bold">{cpuCores}</div>
              <div className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                {serverType} • Load: {loadAverage === undefined ? "n/a" : loadAverage.toFixed(2)}
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-3">
            <div className="rounded-[var(--con-radius-sm)] bg-[color:var(--con-info-soft)] p-2 text-[color:var(--con-info)]">
              <Database size={20} />
            </div>
            <div>
              <div className="con-card-title">System Memory</div>
              <div className="font-bold">
                {memoryTotalBytes === undefined ? "Unavailable" : formatBytes(memoryTotalBytes)}
              </div>
              <div className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                {memPct === undefined || memoryFreeBytes === undefined
                  ? "Utilization unavailable"
                  : `${memPct}% used (${formatBytes(memoryTotalBytes! - memoryFreeBytes)} used, ${formatBytes(memoryFreeBytes)} free)`}
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-3">
            <div className="rounded-[var(--con-radius-sm)] bg-[color:var(--con-accent-soft)] p-2 text-[color:var(--con-accent)]">
              <HardDrive size={20} />
            </div>
            <div>
              <div className="con-card-title">Disk Storage</div>
              <div className="font-bold">
                {diskTotalBytes === undefined ? "Unavailable" : formatBytes(diskTotalBytes)}
              </div>
              <div className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                {diskUsedPct === undefined || diskFreeBytes === undefined
                  ? "Storage unavailable"
                  : `${diskUsedPct}% used (${formatBytes(diskUsedBytes!)} used, ${formatBytes(diskFreeBytes)} avail)`}
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-3">
            <div className="rounded-[var(--con-radius-sm)] bg-[color:var(--con-warn-soft)] p-2 text-[color:var(--con-warn)]">
              <Activity size={20} />
            </div>
            <div>
              <div className="con-card-title">Host Uptime</div>
              <div className="font-bold">
                {uptimeSeconds === undefined ? "Unavailable" : formatUptime(uptimeSeconds)}
              </div>
              <div className="mt-0.5 max-w-[180px] truncate text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                {hostOs}
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Main Content Layout */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left 2 Columns: Live Utilization and Charts */}
        <div className="space-y-6 lg:col-span-2">
          {/* Real-time Rings / Progress */}
          <Card
            title={
              <span className="flex items-center gap-1.5">
                <Activity className="h-4 w-4" /> Live Resource Load
              </span>
            }
          >
            <div className="grid gap-6 sm:grid-cols-3">
              {/* CPU Bar */}
              <div>
                <div className="mb-1 flex justify-between text-[length:var(--con-fs-xs)] font-semibold">
                  <span className="text-[color:var(--con-muted)]">CPU Utilization</span>
                  <span className="con-num">{currentCpu === undefined ? "Unavailable" : `${currentCpu}%`}</span>
                </div>
                {currentCpu !== undefined ? <Meter value={currentCpu} max={100} /> : <div className="h-2 w-full rounded-full bg-[color:var(--con-line)] opacity-50" />}
              </div>

              {/* Memory Bar */}
              <div>
                <div className="mb-1 flex justify-between text-[length:var(--con-fs-xs)] font-semibold">
                  <span className="text-[color:var(--con-muted)]">RAM Utilization</span>
                  <span className="con-num">{memPct === undefined ? "Unavailable" : `${memPct}%`}</span>
                </div>
                {memPct !== undefined ? <Meter value={memPct} max={100} /> : <div className="h-2 w-full rounded-full bg-[color:var(--con-line)] opacity-50" />}
              </div>

              {/* Disk Bar */}
              <div>
                <div className="mb-1 flex justify-between text-[length:var(--con-fs-xs)] font-semibold">
                  <span className="text-[color:var(--con-muted)]">Disk Utilization</span>
                  <span className="con-num">{diskUsedPct === undefined ? "Unavailable" : `${diskUsedPct}%`}</span>
                </div>
                {diskUsedPct !== undefined ? <Meter value={diskUsedPct} max={100} /> : <div className="h-2 w-full rounded-full bg-[color:var(--con-line)] opacity-50" />}
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-4 border-t border-[color:var(--con-line)] pt-4 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              <div>
                <div className="flex items-center gap-1"><ArrowDown size={12} className="text-[color:var(--con-pos)]" /> Disk Read</div>
                <div className="con-num mt-0.5 font-semibold text-[color:var(--con-fg)]">{currentDiskRead === undefined ? "Unavailable" : formatBandwidth(currentDiskRead)}</div>
              </div>
              <div>
                <div className="flex items-center gap-1"><ArrowUp size={12} className="text-[color:var(--con-accent)]" /> Disk Write</div>
                <div className="con-num mt-0.5 font-semibold text-[color:var(--con-fg)]">{currentDiskWrite === undefined ? "Unavailable" : formatBandwidth(currentDiskWrite)}</div>
              </div>
              <div>
                <div className="flex items-center gap-1"><ArrowDown size={12} className="text-[color:var(--con-pos)]" /> Network In (Rx)</div>
                <div className="con-num mt-0.5 font-semibold text-[color:var(--con-fg)]">{currentNetRx === undefined ? "Unavailable" : formatBandwidth(currentNetRx)}</div>
              </div>
              <div>
                <div className="flex items-center gap-1"><ArrowUp size={12} className="text-[color:var(--con-accent)]" /> Network Out (Tx)</div>
                <div className="con-num mt-0.5 font-semibold text-[color:var(--con-fg)]">{currentNetTx === undefined ? "Unavailable" : formatBandwidth(currentNetTx)}</div>
              </div>
            </div>
          </Card>

          {/* CPU Chart */}
          <Card
            title={
              <span className="flex items-center gap-1.5">
                <Cpu className="h-4 w-4" /> CPU History (Last 1 Hour)
                {metrics && metrics.cpu && metrics.cpu.length > 0 && <span className="ml-2 font-normal text-[color:var(--con-faint)]">Max: 100%</span>}
              </span>
            }
          >
            <div className="h-44 w-full">
              {metrics && metrics.cpu && metrics.cpu.length > 0 ? (
                <SparklineChart points={metrics.cpu} yMax={100} stroke="var(--con-accent)" fill="var(--con-accent)" />
              ) : (
                <div className="flex h-full items-center justify-center text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">No historical data available</div>
              )}
            </div>
          </Card>

          {/* Network Chart */}
          <Card
            title={
              <span className="flex items-center gap-1.5">
                <Globe className="h-4 w-4" /> Network Bandwidth
              </span>
            }
          >
            <div className="h-44 w-full">
              {metrics && metrics.networkRx && metrics.networkRx.length > 0 ? (
                <DualLineChart
                  seriesA={metrics.networkRx}
                  seriesB={metrics.networkTx}
                  labelA="Rx (Inbound)"
                  labelB="Tx (Outbound)"
                  formatValue={formatBandwidth}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">No historical data available</div>
              )}
            </div>
          </Card>
        </div>

        {/* Right 1 Column: Services & Action Runners Container Health */}
        <div className="space-y-6">
          <Card
            title={
              <span className="flex items-center gap-1.5">
                <Layers className="h-4 w-4" /> Services & Action Runners
              </span>
            }
          >
            {resources.length === 0 ? (
              <div className="py-6 text-center text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">No containers registered or active</div>
            ) : (
              <div className="space-y-3">
                {resources.map((item) => {
                  const isHealthy = item.status.includes("healthy") || item.status === "running";
                  const isDegraded = item.status.includes("unhealthy") || item.status.includes("degraded");
                  const tone = isHealthy ? "pos" : isDegraded ? "neg" : "warn";

                  return (
                    <div
                      key={item.uuid}
                      className="flex items-center justify-between border-b border-[color:var(--con-line)] pb-3 last:border-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[length:var(--con-fs-sm)] font-semibold">{item.name}</div>
                        <div className="text-[length:var(--con-fs-xs)] capitalize text-[color:var(--con-muted)]">{item.type}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Dot tone={tone} pulse={!isHealthy} />
                        <span className="text-[length:var(--con-fs-xs)] font-medium uppercase">{item.status.split(":")[0]}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card
            title={
              <span className="flex items-center gap-1.5">
                <Shield className="h-4 w-4" /> Security & Access
              </span>
            }
          >
            <div className="space-y-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              <p>
                All endpoint communication between the dashboard, Hetzner API, and Coolify host is encrypted via SSL/TLS.
              </p>
              <div className="con-tile text-[color:var(--con-faint)]">
                <span className="mb-1 block font-bold text-[color:var(--con-muted)]">Server Ingress rules:</span>
                • Port 80/443 (HTTP/S proxy via Traefik)<br />
                • Port 22 (SSH root access restricted)<br />
                • In-container litestream PITR backup replication to Cloudflare R2 Cloud Storage.
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── SVG Sparkline Chart ───────────────────────────────────────────────────────
function SparklineChart({ points, yMax, stroke, fill }: { points: MetricPoint[]; yMax?: number; stroke: string; fill: string }) {
  if (points.length < 2) return null;
  const values = points.map(p => p.value);
  const minVal = 0;
  const maxVal = yMax || Math.max(...values, 1);

  const width = 500;
  const height = 150;
  const padding = 10;

  const pointsCount = points.length;
  const xScale = (width - padding * 2) / (pointsCount - 1);
  const yScale = (height - padding * 2) / (maxVal - minVal);

  const svgPoints = points.map((p, i) => {
    const x = padding + i * xScale;
    const y = height - padding - (p.value - minVal) * yScale;
    return `${x},${y}`;
  });

  const pathD = `M ${svgPoints.join(" L ")}`;
  const areaD = `${pathD} L ${padding + (pointsCount - 1) * xScale},${height - padding} L ${padding},${height - padding} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible">
      <defs>
        <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fill} stopOpacity="0.25" />
          <stop offset="100%" stopColor={fill} stopOpacity="0.00" />
        </linearGradient>
      </defs>
      {/* Grid lines */}
      <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="var(--con-line)" strokeWidth={0.5} strokeDasharray="3" />
      <line x1={padding} y1={height / 2} x2={width - padding} y2={height / 2} stroke="var(--con-line)" strokeWidth={0.5} strokeDasharray="3" />
      <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="var(--con-line)" strokeWidth={0.5} />
      {/* Area */}
      <path d={areaD} fill="url(#chartGrad)" />
      {/* Line */}
      <path d={pathD} fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {/* Max reference line */}
      <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke={stroke} strokeWidth={1} strokeDasharray="4" opacity={0.3} />
    </svg>
  );
}

// ── SVG Dual Line Chart ────────────────────────────────────────────────────────
function DualLineChart({
  seriesA,
  seriesB,
  labelA,
  labelB,
  formatValue
}: {
  seriesA: MetricPoint[];
  seriesB: MetricPoint[];
  labelA: string;
  labelB: string;
  formatValue: (v: number) => string;
}) {
  if (seriesA.length < 2 || seriesB.length < 2) return null;

  const valsA = seriesA.map(p => p.value);
  const valsB = seriesB.map(p => p.value);
  const maxVal = Math.max(...valsA, ...valsB, 1024);

  const width = 500;
  const height = 150;
  const padding = 10;

  const xScale = (width - padding * 2) / (seriesA.length - 1);
  const yScale = (height - padding * 2) / maxVal;

  const buildPath = (series: MetricPoint[]) => {
    return series.map((p, i) => {
      const x = padding + i * xScale;
      const y = height - padding - p.value * yScale;
      return `${x},${y}`;
    }).join(" L ");
  };

  const pathA = `M ${buildPath(seriesA)}`;
  const pathB = `M ${buildPath(seriesB)}`;

  return (
    <div className="h-full flex flex-col justify-between">
      <div className="flex items-center gap-4 self-end text-[10px] text-[color:var(--con-muted)]">
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-4 rounded bg-[color:var(--con-pos)]" /> {labelA} (Max: {formatValue(Math.max(...valsA))})
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-4 rounded bg-[color:var(--con-accent)]" /> {labelB} (Max: {formatValue(Math.max(...valsB))})
        </span>
      </div>
      <div className="flex-1 h-36 mt-2">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible">
          {/* Grid lines */}
          <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="var(--con-line)" strokeWidth={0.5} strokeDasharray="3" />
          <line x1={padding} y1={height / 2} x2={width - padding} y2={height / 2} stroke="var(--con-line)" strokeWidth={0.5} strokeDasharray="3" />
          <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="var(--con-line)" strokeWidth={0.5} />

          {/* Line A */}
          <path d={pathA} fill="none" stroke="var(--con-pos)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          {/* Line B */}
          <path d={pathB} fill="none" stroke="var(--con-accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          {/* Max reference line */}
          <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="var(--con-muted)" strokeWidth={1} strokeDasharray="4" opacity={0.3} />
        </svg>
      </div>
    </div>
  );
}
