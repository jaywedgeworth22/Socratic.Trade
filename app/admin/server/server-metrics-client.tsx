"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, Chip, Dot } from "../../ui/primitives";
import { Server, Cpu, Database, Activity, RefreshCw, Layers, ArrowDown, ArrowUp, Globe, Shield } from "lucide-react";
import { asRecord, normalizeCoolifyResources, readText } from "@/lib/server-metrics-shapes";

interface MetricPoint {
  timestamp: number;
  value: number;
}

interface HostInfo {
  name: string;
  status: string;
  os: string;
  cpus: number;
  memoryTotalBytes: number;
  memoryFreeBytes: number;
  uptimeSeconds: number;
  loadAvg?: number[];
  // JSON is an untrusted runtime boundary. These are normalized to strings by
  // the API, but remain unknown here so a future provider regression renders a
  // diagnostic instead of passing an object to React.
  serverType?: unknown;
  location?: unknown;
  ip?: unknown;
}

interface ServerMetricsData {
  isProd: boolean;
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

export function ServerMetricsClient() {
  const [data, setData] = useState<ServerMetricsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoPoll, setAutoPoll] = useState(true);

  const fetchMetrics = useCallback(async (isSilent = false) => {
    if (!isSilent) setRefreshing(true);
    try {
      const res = await fetch("/api/admin/server-metrics");
      if (res.ok) {
        const json = await res.json();
        setData(json);
      } else {
        const json: unknown = await res.json().catch(() => undefined);
        const envelope = asRecord(json);
        const error = readText(envelope?.error) || "Failed to load metrics";
        // The API intentionally returns real local-host metadata with empty
        // remote datasets on provider failure. Preserve that useful receipt
        // even on a non-2xx response; reject unrelated/malformed error JSON.
        if (asRecord(envelope?.hostInfo) && asRecord(envelope?.metrics) && Array.isArray(envelope?.resources)) {
          setData({ ...(envelope as unknown as ServerMetricsData), error });
        } else {
          setData((prev) => prev ? { ...prev, error } : null);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  useEffect(() => {
    if (!autoPoll) return;
    const timer = setInterval(() => {
      fetchMetrics(true);
    }, 30000);
    return () => clearInterval(timer);
  }, [autoPoll, fetchMetrics]);

  if (loading) {
    return (
      <div className="flex h-[50vh] flex-col items-center justify-center gap-3">
        <RefreshCw className="h-8 w-8 animate-spin text-accent" />
        <span className="text-sm text-muted">Polling infrastructure health...</span>
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
  const hostIp = displayProviderText(host?.ip, "127.0.0.1", "server IP");
  const hostLocation = displayProviderText(host?.location, "local", "server location");
  const serverType = displayProviderText(host?.serverType, "vps", "server type");

  const usedMem = host ? host.memoryTotalBytes - host.memoryFreeBytes : 0;
  const memPct = host ? Math.round((usedMem / host.memoryTotalBytes) * 100) : 0;

  // CPU average of last 3 points
  const latestCpuValues = metrics?.cpu?.slice(-3).map(p => p.value) || [];
  const currentCpu = latestCpuValues.length > 0 
    ? Math.round(latestCpuValues.reduce((a, b) => a + b, 0) / latestCpuValues.length) 
    : 0;

  // Disk/Network average speed of last 3 points
  const getLatestAvg = (points?: MetricPoint[]) => {
    const vals = points?.slice(-3).map(p => p.value) || [];
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };

  const currentDiskRead = getLatestAvg(metrics?.diskRead);
  const currentDiskWrite = getLatestAvg(metrics?.diskWrite);
  const currentNetRx = getLatestAvg(metrics?.networkRx);
  const currentNetTx = getLatestAvg(metrics?.networkTx);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      {/* Header Info */}
      <header className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-fg">Server & infrastructure</h1>
            {data?.isProd ? (
              <Chip tone="accent">PRODUCTION</Chip>
            ) : (
              <Chip tone="warn">LOCAL HOST</Chip>
            )}
          </div>
          <p className="mt-1 text-sm text-muted">
            Host node metrics and Coolify application resource statuses.
          </p>
        </div>
        <div className="flex items-center gap-3 self-start max-sm:w-full">
          <label className="flex items-center gap-2 text-xs text-muted max-sm:mr-auto">
            <input 
              type="checkbox" 
              checked={autoPoll} 
              onChange={(e) => setAutoPoll(e.target.checked)}
              className="rounded border-line bg-surface text-accent focus:ring-accent"
            />
            Auto-refresh (30s)
          </label>
          <button
            type="button"
            onClick={() => fetchMetrics()}
            disabled={refreshing}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-line bg-surface px-4 text-xs font-semibold text-fg transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </header>

      {data?.error && (
        <div className="mb-6 rounded-xl border border-neg/20 bg-neg/5 p-4 text-sm text-neg">
          <span className="font-semibold">Error retrieving full metrics:</span> {data.error}. Showing local host metrics.
        </div>
      )}

      {warnings.length > 0 && (
        <div className="mb-6 rounded-xl border border-warn/20 bg-warn/5 p-4 text-sm text-warn" role="status">
          <span className="font-semibold">Provider metadata warning:</span> {warnings.join(" ")}
        </div>
      )}

      {/* Host Details Grid */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4 flex items-center gap-3">
          <div className="rounded-lg bg-accent/8 p-2 text-accent">
            <Server size={20} />
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Host Server</div>
            <div className="font-bold text-fg">{host?.name || "localhost"}</div>
            <div className="text-xs text-muted flex items-center gap-1.5 mt-0.5">
              <Globe size={11} /> {hostIp} • {hostLocation}
            </div>
          </div>
        </Card>

        <Card className="p-4 flex items-center gap-3">
          <div className="rounded-lg bg-pos/8 p-2 text-pos">
            <Cpu size={20} />
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">CPU Cores</div>
            <div className="font-bold text-fg">{host?.cpus || 2} Cores</div>
            <div className="text-xs text-muted mt-0.5">
              {serverType} • Load: {host?.loadAvg ? host.loadAvg[0].toFixed(2) : "n/a"}
            </div>
          </div>
        </Card>

        <Card className="p-4 flex items-center gap-3">
          <div className="rounded-lg bg-info/8 p-2 text-info">
            <Database size={20} />
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">System Memory</div>
            <div className="font-bold text-fg">{formatBytes(host?.memoryTotalBytes || 0)}</div>
            <div className="text-xs text-muted mt-0.5">
              {memPct}% used • {formatBytes(host ? host.memoryFreeBytes : 0)} free
            </div>
          </div>
        </Card>

        <Card className="p-4 flex items-center gap-3">
          <div className="rounded-lg bg-warn/8 p-2 text-warn">
            <Activity size={20} />
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Host Uptime</div>
            <div className="font-bold text-fg">{formatUptime(host?.uptimeSeconds || 0)}</div>
            <div className="text-xs text-muted mt-0.5 truncate max-w-[180px]">
              {host?.os || "Ubuntu"}
            </div>
          </div>
        </Card>
      </div>

      {/* Main Content Layout */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left 2 Columns: Live Utilization and Charts */}
        <div className="lg:col-span-2 space-y-6">
          {/* Real-time Rings / Progress */}
          <Card className="p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-4 flex items-center gap-1.5">
              <Activity className="h-4 w-4" /> Live Resource Load
            </h2>
            <div className="grid gap-6 sm:grid-cols-2">
              {/* CPU Bar */}
              <div>
                <div className="flex justify-between text-xs font-semibold mb-1">
                  <span className="text-muted">CPU Utilization</span>
                  <span className="text-fg">{currentCpu}%</span>
                </div>
                <div className="h-2 w-full rounded-full bg-surface-3 overflow-hidden">
                  <div 
                    className="h-full bg-accent transition-all duration-500" 
                    style={{ width: `${currentCpu}%` }}
                  />
                </div>
              </div>

              {/* Memory Bar */}
              <div>
                <div className="flex justify-between text-xs font-semibold mb-1">
                  <span className="text-muted">RAM Utilization</span>
                  <span className="text-fg">{memPct}%</span>
                </div>
                <div className="h-2 w-full rounded-full bg-surface-3 overflow-hidden">
                  <div 
                    className="h-full bg-info transition-all duration-500" 
                    style={{ width: `${memPct}%` }}
                  />
                </div>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-4 border-t border-line pt-4 text-xs text-muted">
              <div>
                <div className="flex items-center gap-1"><ArrowDown size={12} className="text-pos" /> Disk Read</div>
                <div className="font-semibold text-fg mt-0.5">{formatBandwidth(currentDiskRead)}</div>
              </div>
              <div>
                <div className="flex items-center gap-1"><ArrowUp size={12} className="text-accent" /> Disk Write</div>
                <div className="font-semibold text-fg mt-0.5">{formatBandwidth(currentDiskWrite)}</div>
              </div>
              <div>
                <div className="flex items-center gap-1"><ArrowDown size={12} className="text-pos" /> Network In (Rx)</div>
                <div className="font-semibold text-fg mt-0.5">{formatBandwidth(currentNetRx)}</div>
              </div>
              <div>
                <div className="flex items-center gap-1"><ArrowUp size={12} className="text-accent" /> Network Out (Tx)</div>
                <div className="font-semibold text-fg mt-0.5">{formatBandwidth(currentNetTx)}</div>
              </div>
            </div>
          </Card>

          {/* CPU Chart */}
          <Card className="p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-4 flex items-center gap-1.5">
              <Cpu className="h-4 w-4" /> CPU History (Last 1 Hour)
            </h2>
            <div className="h-44 w-full">
              {metrics && metrics.cpu && metrics.cpu.length > 0 ? (
                <SparklineChart points={metrics.cpu} yMax={100} stroke="var(--accent)" fill="var(--accent)" />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-faint">No historical data available</div>
              )}
            </div>
          </Card>

          {/* Network Chart */}
          <Card className="p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-4 flex items-center gap-1.5">
              <Globe className="h-4 w-4" /> Network Bandwidth
            </h2>
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
                <div className="flex h-full items-center justify-center text-xs text-faint">No historical data available</div>
              )}
            </div>
          </Card>
        </div>

        {/* Right 1 Column: Coolify Application Container Health */}
        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-4 flex items-center gap-1.5">
              <Layers className="h-4 w-4" /> Coolify Services
            </h2>
            {resources.length === 0 ? (
              <div className="py-6 text-center text-xs text-faint">No containers registered or active</div>
            ) : (
              <div className="space-y-3">
                {resources.map((item) => {
                  const isHealthy = item.status.includes("healthy") || item.status === "running";
                  const isDegraded = item.status.includes("unhealthy") || item.status.includes("degraded");
                  const tone = isHealthy ? "pos" : isDegraded ? "neg" : "warn";
                  
                  return (
                    <div 
                      key={item.uuid} 
                      className="flex items-center justify-between border-b border-line pb-3 last:border-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold text-sm text-fg truncate">{item.name}</div>
                        <div className="text-xs text-muted capitalize">{item.type}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Dot tone={tone} pulse={!isHealthy} />
                        <span className="text-xs font-medium uppercase text-fg">{item.status.split(":")[0]}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-3 flex items-center gap-1.5">
              <Shield className="h-4 w-4" /> Security & Access
            </h2>
            <div className="space-y-3 text-xs text-muted">
              <p>
                All endpoint communication between the dashboard, Hetzner API, and Coolify host is encrypted via SSL/TLS.
              </p>
              <div className="rounded-lg bg-surface-2 p-3 text-faint">
                <span className="font-bold text-muted block mb-1">Server Ingress rules:</span>
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
      <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="var(--line)" strokeWidth={0.5} strokeDasharray="3" />
      <line x1={padding} y1={height / 2} x2={width - padding} y2={height / 2} stroke="var(--line)" strokeWidth={0.5} strokeDasharray="3" />
      <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="var(--line)" strokeWidth={0.5} />
      
      {/* Area */}
      <path d={areaD} fill="url(#chartGrad)" />
      {/* Line */}
      <path d={pathD} fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
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
      <div className="flex items-center gap-4 text-[10px] text-muted self-end">
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-4 bg-pos rounded" /> {labelA} (Max: {formatValue(Math.max(...valsA))})
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-4 bg-accent rounded" /> {labelB} (Max: {formatValue(Math.max(...valsB))})
        </span>
      </div>
      <div className="flex-1 h-36 mt-2">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible">
          {/* Grid lines */}
          <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke="var(--line)" strokeWidth={0.5} strokeDasharray="3" />
          <line x1={padding} y1={height / 2} x2={width - padding} y2={height / 2} stroke="var(--line)" strokeWidth={0.5} strokeDasharray="3" />
          <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="var(--line)" strokeWidth={0.5} />
          
          {/* Line A */}
          <path d={pathA} fill="none" stroke="var(--pos)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          {/* Line B */}
          <path d={pathB} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
}
