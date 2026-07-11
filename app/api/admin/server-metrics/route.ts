import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import {
  asRecord,
  normalizeCoolifyResources,
  normalizeHetznerServerResponse,
  readPositiveNumber,
  readText,
} from "@/lib/server-metrics-shapes";
import os from "os";

export const dynamic = "force-dynamic";

interface MetricValue {
  timestamp: number;
  value: number;
}

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const hetznerToken = process.env.HETZNER_API_TOKEN;
  const hetznerServerId = process.env.HETZNER_SERVER_ID;
  const coolifyToken = process.env.COOLIFY_API_TOKEN;
  const coolifyServerUuid = process.env.COOLIFY_SERVER_UUID;

  const isConfigured = !!(hetznerToken && hetznerServerId && coolifyToken && coolifyServerUuid);

  // Default local/fallback values using native Node os module
  const localHostInfo = {
    name: os.hostname(),
    status: "running",
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpus: os.cpus().length,
    memoryTotalBytes: os.totalmem(),
    memoryFreeBytes: os.freemem(),
    uptimeSeconds: os.uptime(),
    loadAvg: os.loadavg(),
  };

  if (!isConfigured) {
    // Return fallback local stats in development or when not configured
    return NextResponse.json({
      isProd: false,
      hostInfo: localHostInfo,
      resources: [],
      metrics: emptyMetrics(),
      asOf: new Date().toISOString(),
    });
  }

  try {
    // 1. Fetch server metadata and resources from Coolify API
    const coolifyHeaders = {
      Authorization: `Bearer ${coolifyToken}`,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json",
    };

    const serverUrl = `https://host.jays.services/api/v1/servers/${coolifyServerUuid}`;
    const resourcesUrl = `${serverUrl}/resources`;

    const [coolifyServerFetch, coolifyResourcesFetch] = await Promise.all([
      fetchProviderJson("Coolify server metadata", serverUrl, coolifyHeaders),
      fetchProviderJson("Coolify resources", resourcesUrl, coolifyHeaders),
    ]);

    // 2. Fetch server details and metrics from Hetzner Cloud API
    const hetznerHeaders = {
      Authorization: `Bearer ${hetznerToken}`,
      Accept: "application/json",
    };

    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const startStr = oneHourAgo.toISOString();
    const endStr = now.toISOString();

    const hetznerUrl = `https://api.hetzner.cloud/v1/servers/${hetznerServerId}`;
    const hetznerMetricsUrl = `${hetznerUrl}/metrics?type=cpu&type=disk&type=network&start=${startStr}&end=${endStr}`;

    const [hetznerServerFetch, hetznerMetricsFetch] = await Promise.all([
      fetchProviderJson("Hetzner server metadata", hetznerUrl, hetznerHeaders),
      fetchProviderJson("Hetzner metrics", hetznerMetricsUrl, hetznerHeaders),
    ]);

    // Parse provider responses at the API boundary. Never forward nested
    // provider objects to the client as display strings.
    const hetznerMetrics = asRecord(asRecord(hetznerMetricsFetch.payload)?.metrics);
    const rawTimeSeries = hetznerMetrics?.time_series;
    const parsedMetrics = parseHetznerTimeSeries(rawTimeSeries);

    // Merge metadata
    const coolifyServer = asRecord(coolifyServerFetch.payload);
    const coolifyMeta = asRecord(coolifyServer?.server_metadata);
    const normalizedHetzner = normalizeHetznerServerResponse(hetznerServerFetch.payload);
    const normalizedResources = normalizeCoolifyResources(coolifyResourcesFetch.payload);
    const hcloudMeta = normalizedHetzner.server;
    const providerErrors = [
      coolifyServerFetch.error,
      coolifyResourcesFetch.error,
      hetznerServerFetch.error,
      hetznerMetricsFetch.error,
    ].filter((error): error is string => Boolean(error));
    const warnings = [
      ...providerErrors,
      ...normalizedHetzner.warnings,
      ...normalizedResources.warnings,
      ...parsedMetrics.warnings,
    ];

    const hostInfo = {
      name: hcloudMeta.name || readText(coolifyServer?.name),
      status: hcloudMeta.status || "unknown",
      os: readText(coolifyMeta?.os),
      cpus: readPositiveNumber(coolifyMeta?.cpus),
      memoryTotalBytes: readPositiveNumber(coolifyMeta?.memory_bytes),
      serverType: hcloudMeta.serverType,
      location: hcloudMeta.location,
      ip: hcloudMeta.ip,
    };

    return NextResponse.json({
      isProd: true,
      degraded: warnings.length > 0,
      ...(providerErrors.length > 0
        ? { error: "One or more infrastructure providers could not be queried." }
        : {}),
      hostInfo,
      resources: normalizedResources.resources,
      metrics: parsedMetrics.metrics,
      asOf: new Date().toISOString(),
      ...(warnings.length > 0 ? { warnings } : {}),
    }, { status: providerErrors.length > 0 ? 502 : 200 });
  } catch (err: unknown) {
    return NextResponse.json({
      isProd: true,
      degraded: true,
      error: err instanceof Error ? err.message : "Failed to fetch remote server metrics",
      hostInfo: { status: "unknown" },
      resources: [],
      metrics: emptyMetrics(),
      asOf: new Date().toISOString(),
    }, { status: 500 });
  }
}

function parseHetznerTimeSeries(timeSeries: unknown): {
  metrics: Record<string, MetricValue[]>;
  warnings: string[];
} {
  const series = asRecord(timeSeries) ?? {};
  let omittedSamples = 0;
  const result: Record<string, MetricValue[]> = {
    cpu: [],
    diskRead: [],
    diskWrite: [],
    networkRx: [],
    networkTx: [],
  };

  const getValues = (key: string): MetricValue[] => {
    const raw = asRecord(series[key])?.values;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      if (!Array.isArray(item) || item.length < 2) {
        omittedSamples += 1;
        return [];
      }
      const timestamp = toFiniteMetricNumber(item[0]);
      const value = toFiniteMetricNumber(item[1]);
      if (timestamp === undefined || value === undefined) {
        omittedSamples += 1;
        return [];
      }
      return [{ timestamp, value }];
    });
  };

  // Find actual keys in the returned map (e.g. disk.0.bandwidth.read, network.0.bandwidth.rx)
  const cpuKey = Object.keys(series).find((k) => k.startsWith("cpu")) || "cpu";
  const diskReadKey = Object.keys(series).find((k) => k.includes("bandwidth.read")) || "disk.0.bandwidth.read";
  const diskWriteKey = Object.keys(series).find((k) => k.includes("bandwidth.write")) || "disk.0.bandwidth.write";
  const netRxKey = Object.keys(series).find((k) => k.includes("bandwidth.rx")) || "network.0.bandwidth.rx";
  const netTxKey = Object.keys(series).find((k) => k.includes("bandwidth.tx")) || "network.0.bandwidth.tx";

  result.cpu = getValues(cpuKey);
  result.diskRead = getValues(diskReadKey);
  result.diskWrite = getValues(diskWriteKey);
  result.networkRx = getValues(netRxKey);
  result.networkTx = getValues(netTxKey);

  return {
    metrics: result,
    warnings: omittedSamples > 0
      ? [`Hetzner metrics contained ${omittedSamples} malformed samples that were omitted.`]
      : [],
  };
}

async function fetchProviderJson(
  label: string,
  url: string,
  headers: Record<string, string>,
): Promise<{ payload?: unknown; error?: string }> {
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { error: `${label} returned HTTP ${response.status}.` };
    }
    try {
      return { payload: await response.json() };
    } catch {
      return { error: `${label} returned invalid JSON.` };
    }
  } catch {
    return { error: `${label} was unavailable.` };
  }
}

function toFiniteMetricNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function emptyMetrics(): Record<string, MetricValue[]> {
  return {
    cpu: [],
    diskRead: [],
    diskWrite: [],
    networkRx: [],
    networkTx: [],
  };
}
