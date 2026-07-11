import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
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
      resources: [
        { uuid: "mock-socratic-trade", name: "socratic-trade-prod", type: "application", status: "running:healthy" },
        { uuid: "mock-runner-1", name: "socratic-deploy-runner", type: "service", status: "running" },
        { uuid: "mock-runner-2", name: "congress-deploy-runner", type: "service", status: "running" },
        { uuid: "mock-sentinel", name: "coolify-sentinel", type: "service", status: "running:healthy" },
      ],
      metrics: generateMockMetrics(),
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
      fetch(resourcesUrl, { headers: coolifyHeaders }).then((r) => r.json()).catch(() => []),
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

    // Parse metrics
    const rawTimeSeries = hetznerMetricsRes?.metrics?.time_series || {};
    const parsedMetrics = parseHetznerTimeSeries(rawTimeSeries);

    // Merge metadata
    const coolifyMeta = serverRes?.server_metadata || {};
    const hcloudMeta = hetznerServerRes?.server || {};

    const hostInfo = {
      name: hcloudMeta.name || serverRes?.name || localHostInfo.name,
      status: hcloudMeta.status || "running",
      os: coolifyMeta.os || localHostInfo.os,
      cpus: coolifyMeta.cpus || localHostInfo.cpus,
      memoryTotalBytes: coolifyMeta.memory_bytes || localHostInfo.memoryTotalBytes,
      memoryFreeBytes: localHostInfo.memoryFreeBytes,
      uptimeSeconds: localHostInfo.uptimeSeconds, // fall back to local uptime check
      serverType: hcloudMeta.server_type || "vps",
      location: hcloudMeta.datacenter?.name || "hel1",
      ip: hcloudMeta.public_net?.ipv4 || "135.181.192.190",
    };

    return NextResponse.json({
      isProd: true,
      hostInfo,
      resources: Array.isArray(resourcesRes) ? resourcesRes : [],
      metrics: parsedMetrics,
      asOf: new Date().toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json({
      isProd: true,
      error: err.message || "Failed to fetch remote server metrics",
      hostInfo: localHostInfo,
      resources: [],
      metrics: generateMockMetrics(),
      asOf: new Date().toISOString(),
    }, { status: 500 });
  }
}

function parseHetznerTimeSeries(timeSeries: any) {
  const result: Record<string, MetricValue[]> = {
    cpu: [],
    diskRead: [],
    diskWrite: [],
    networkRx: [],
    networkTx: [],
  };

  const getValues = (key: string): MetricValue[] => {
    const raw = timeSeries[key]?.values || [];
    return raw.map((item: [number, string]) => ({
      timestamp: item[0],
      value: parseFloat(item[1]) || 0,
    }));
  };

  // Find actual keys in the returned map (e.g. disk.0.bandwidth.read, network.0.bandwidth.rx)
  const cpuKey = Object.keys(timeSeries).find((k) => k.startsWith("cpu")) || "cpu";
  const diskReadKey = Object.keys(timeSeries).find((k) => k.includes("bandwidth.read")) || "disk.0.bandwidth.read";
  const diskWriteKey = Object.keys(timeSeries).find((k) => k.includes("bandwidth.write")) || "disk.0.bandwidth.write";
  const netRxKey = Object.keys(timeSeries).find((k) => k.includes("bandwidth.rx")) || "network.0.bandwidth.rx";
  const netTxKey = Object.keys(timeSeries).find((k) => k.includes("bandwidth.tx")) || "network.0.bandwidth.tx";

  result.cpu = getValues(cpuKey);
  result.diskRead = getValues(diskReadKey);
  result.diskWrite = getValues(diskWriteKey);
  result.networkRx = getValues(netRxKey);
  result.networkTx = getValues(netTxKey);

  return result;
}

function generateMockMetrics() {
  const now = Math.floor(Date.now() / 1000);
  const cpu: MetricValue[] = [];
  const diskRead: MetricValue[] = [];
  const diskWrite: MetricValue[] = [];
  const networkRx: MetricValue[] = [];
  const networkTx: MetricValue[] = [];

  for (let i = 60; i >= 0; i -= 2) {
    const ts = now - i * 60;
    // Generate organic-looking mock values
    const seed = Math.sin(ts / 1000);
    cpu.push({ timestamp: ts, value: Math.abs(15 + seed * 10 + Math.random() * 5) });
    diskRead.push({ timestamp: ts, value: Math.abs(1024 * 50 + seed * 20000 + Math.random() * 10000) });
    diskWrite.push({ timestamp: ts, value: Math.abs(1024 * 10 + seed * 5000 + Math.random() * 3000) });
    networkRx.push({ timestamp: ts, value: Math.abs(1024 * 150 + seed * 80000 + Math.random() * 30000) });
    networkTx.push({ timestamp: ts, value: Math.abs(1024 * 30 + seed * 10000 + Math.random() * 5000) });
  }

  return { cpu, diskRead, diskWrite, networkRx, networkTx };
}
