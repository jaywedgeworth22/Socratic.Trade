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

    const [serverRes, resourcesRes] = await Promise.all([
      fetch(serverUrl, { headers: coolifyHeaders }).then((r) => r.json()).catch(() => null),
      fetch(resourcesUrl, { headers: coolifyHeaders }).then((r) => r.json()).catch(() => null),
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

    const [hetznerServerRes, hetznerMetricsRes] = await Promise.all([
      fetch(hetznerUrl, { headers: hetznerHeaders }).then((r) => r.json()).catch(() => null),
      fetch(hetznerMetricsUrl, { headers: hetznerHeaders }).then((r) => r.json()).catch(() => null),
    ]);

    // Parse provider responses at the API boundary. Never forward nested
    // provider objects to the client as display strings.
    const hetznerMetrics = asRecord(asRecord(hetznerMetricsRes)?.metrics);
    const rawTimeSeries = hetznerMetrics?.time_series;
    const parsedMetrics = parseHetznerTimeSeries(rawTimeSeries);

    // Merge metadata
    const coolifyServer = asRecord(serverRes);
    const coolifyMeta = asRecord(coolifyServer?.server_metadata);
    const normalizedHetzner = normalizeHetznerServerResponse(hetznerServerRes);
    const normalizedResources = normalizeCoolifyResources(resourcesRes);
    const hcloudMeta = normalizedHetzner.server;
    const warnings = [...normalizedHetzner.warnings, ...normalizedResources.warnings];

    const hostInfo = {
      name: hcloudMeta.name || readText(coolifyServer?.name) || localHostInfo.name,
      status: hcloudMeta.status || "running",
      os: readText(coolifyMeta?.os) || localHostInfo.os,
      cpus: readPositiveNumber(coolifyMeta?.cpus) || localHostInfo.cpus,
      memoryTotalBytes: readPositiveNumber(coolifyMeta?.memory_bytes) || localHostInfo.memoryTotalBytes,
      memoryFreeBytes: localHostInfo.memoryFreeBytes,
      uptimeSeconds: localHostInfo.uptimeSeconds, // fall back to local uptime check
      serverType: hcloudMeta.serverType || "vps",
      location: hcloudMeta.location || "hel1",
      ip: hcloudMeta.ip || "135.181.192.190",
    };

    return NextResponse.json({
      isProd: true,
      hostInfo,
      resources: normalizedResources.resources,
      metrics: parsedMetrics,
      asOf: new Date().toISOString(),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } catch (err: unknown) {
    return NextResponse.json({
      isProd: true,
      error: err instanceof Error ? err.message : "Failed to fetch remote server metrics",
      hostInfo: localHostInfo,
      resources: [],
      metrics: emptyMetrics(),
      asOf: new Date().toISOString(),
    }, { status: 500 });
  }
}

function parseHetznerTimeSeries(timeSeries: unknown) {
  const series = asRecord(timeSeries) ?? {};
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
      if (!Array.isArray(item) || item.length < 2) return [];
      const timestamp = Number(item[0]);
      const value = Number(item[1]);
      if (!Number.isFinite(timestamp)) return [];
      return [{ timestamp, value: Number.isFinite(value) ? value : 0 }];
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

  return result;
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
