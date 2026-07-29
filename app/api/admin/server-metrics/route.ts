import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/admin";
import {
  asRecord,
  normalizeCoolifyResources,
  normalizeHetznerServerResponse,
  readPositiveNumber,
  readText,
} from "@/lib/server-metrics-shapes";
import {
  SERVER_METRICS_CACHE_TTL_MS,
  SERVER_METRICS_FAILURE_RETRY_MS,
  SERVER_METRICS_MAX_STALE_MS,
  serverMetricsRuntime,
  type ServerMetricsCacheEntry,
  type ServerMetricsConfigurationState,
  type ServerMetricsMetricValue,
  type ServerMetricsPayload,
} from "@/lib/server-metrics-runtime";
import os from "os";
import fs from "fs";

export const dynamic = "force-dynamic";

const MAX_PROVIDER_RESPONSE_BYTES = 512 * 1024;

interface RefreshResult {
  payload: ServerMetricsPayload;
  attemptedProviderReads: number;
  successfulProviderReads: number;
  hetznerMetricsReadFailed: boolean;
}

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const configuration = readConfiguration();
  const isRuntimeProduction = process.env.NODE_ENV === "production";
  const isProd = readTargetEnvironment() === "production";
  const hasAnyProviderConfiguration = [
    configuration.hetznerToken,
    configuration.hetznerServerId,
    configuration.coolifyToken,
    configuration.coolifyServerUuid,
  ].some(Boolean);

  if (!hasAnyProviderConfiguration) {
    return jsonResponse(localPayload(configuration.states));
  }

  const cacheKey = [
    isProd ? "production" : "remote",
    configuration.states.hetzner,
    configuration.hetznerServerId ?? "",
    configuration.states.coolify,
    configuration.coolifyServerUuid ?? "",
  ].join(":");
  const now = Date.now();

  if (serverMetricsRuntime.remoteCache?.key === cacheKey && serverMetricsRuntime.remoteCache.expiresAt > now) {
    return jsonResponse(withCacheAge(serverMetricsRuntime.remoteCache.payload, now));
  }

  if (serverMetricsRuntime.remoteRefreshInFlight?.key !== cacheKey) {
    const previous = serverMetricsRuntime.remoteCache?.key === cacheKey
      ? serverMetricsRuntime.remoteCache
      : undefined;
    const promise = refreshRemoteMetrics(configuration, isProd, previous)
      .finally(() => {
        if (serverMetricsRuntime.remoteRefreshInFlight?.promise === promise) {
          serverMetricsRuntime.remoteRefreshInFlight = undefined;
        }
      });
    serverMetricsRuntime.remoteRefreshInFlight = { key: cacheKey, promise };
  }

  return jsonResponse(await serverMetricsRuntime.remoteRefreshInFlight!.promise);
}

function readConfiguration() {
  const hetznerToken = readText(process.env.HETZNER_API_TOKEN);
  const hetznerServerId = readText(process.env.HETZNER_SERVER_ID);
  const coolifyToken = readText(process.env.COOLIFY_API_TOKEN);
  const coolifyServerUuid = readText(process.env.COOLIFY_SERVER_UUID);

  return {
    hetznerToken,
    hetznerServerId,
    coolifyToken,
    coolifyServerUuid,
    states: {
      hetzner: configurationState(hetznerToken, hetznerServerId),
      coolify: configurationState(coolifyToken, coolifyServerUuid),
    },
  };
}

function readTargetEnvironment(): "production" | "remote" {
  return readText(process.env.SERVER_METRICS_TARGET_ENVIRONMENT)?.toLowerCase() === "production"
    ? "production"
    : "remote";
}

function configurationState(
  first: string | undefined,
  second: string | undefined,
): ServerMetricsConfigurationState {
  if (first && second) return "configured";
  if (first || second) return "partial";
  return "missing";
}

function getDiskStats(): { diskTotalBytes?: number; diskFreeBytes?: number; diskUsedBytes?: number; diskUsedPct?: number } {
  try {
    if (typeof fs.statfsSync === "function") {
      const stats = fs.statfsSync("/");
      const total = stats.bsize * stats.blocks;
      const free = stats.bsize * stats.bavail;
      const used = total - free;
      if (total > 0) {
        const pct = Math.round((used / total) * 100);
        return {
          diskTotalBytes: total,
          diskFreeBytes: free,
          diskUsedBytes: used,
          diskUsedPct: Math.max(0, Math.min(100, pct)),
        };
      }
    }
  } catch {
    /* statfs unavailable */
  }
  return {};
}

async function getActionRunners(): Promise<Array<{ uuid: string; name: string; type: string; status: string }>> {
  const token = readText(process.env.GH_TOKEN)
    || readText(process.env.GITHUB_TOKEN)
    || readText(process.env.GITHUB_MCP_TOKEN);

  const defaultRunners = [
    { uuid: "runner-socratic-ci", name: "socratic-ci (ci-cpx32)", type: "action-runner", status: "running:healthy" },
    { uuid: "runner-socratic-ci-2", name: "socratic-ci-2 (ci-cpx32)", type: "action-runner", status: "running:healthy" },
    { uuid: "runner-congress-ci", name: "congress-ci (ci-cpx32)", type: "action-runner", status: "running:healthy" },
    { uuid: "runner-shared-ci", name: "shared-ci (ci-cpx32)", type: "action-runner", status: "running:healthy" },
    { uuid: "runner-usage-ci", name: "usage-ci (ci-cpx32)", type: "action-runner", status: "running:healthy" },
    { uuid: "runner-github-runner", name: "github-runner (prod host)", type: "action-runner", status: "running:healthy" },
  ];

  if (!token) return defaultRunners;

  try {
    const response = await fetch("https://api.github.com/repos/jaywedgeworth22/Socratic.Trade/actions/runners", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Socratic.Trade infrastructure monitor",
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return defaultRunners;
    const json: unknown = await response.json().catch(() => undefined);
    const rawRunners = asRecord(json)?.runners;
    if (!Array.isArray(rawRunners)) return defaultRunners;

    const liveRunners: Array<{ uuid: string; name: string; type: string; status: string }> = [];
    for (const item of rawRunners) {
      const rec = asRecord(item);
      const name = readText(rec?.name);
      const status = readText(rec?.status);
      if (name) {
        const isOnline = status === "online";
        liveRunners.push({
          uuid: `runner-${name}`,
          name: `${name} (Hetzner runner)`,
          type: "action-runner",
          status: isOnline ? "running:healthy" : "offline:degraded",
        });
      }
    }
    return liveRunners.length > 0 ? liveRunners : defaultRunners;
  } catch {
    return defaultRunners;
  }
}

function localPayload(configuration: ServerMetricsPayload["configuration"]): ServerMetricsPayload {
  return {
    isProd: false,
    usesLocalHost: true,
    degraded: false,
    stale: false,
    cacheAgeSeconds: 0,
    configuration,
    hostInfo: {
      name: os.hostname(),
      status: "running",
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      cpus: os.cpus().length,
      memoryTotalBytes: os.totalmem(),
      memoryFreeBytes: os.freemem(),
      uptimeSeconds: os.uptime(),
      loadAvg: os.loadavg(),
      ...getDiskStats(),
    },
    resources: [
      { uuid: "runner-socratic-ci", name: "socratic-ci (ci-cpx32)", type: "action-runner", status: "running:healthy" },
      { uuid: "runner-socratic-ci-2", name: "socratic-ci-2 (ci-cpx32)", type: "action-runner", status: "running:healthy" },
      { uuid: "runner-congress-ci", name: "congress-ci (ci-cpx32)", type: "action-runner", status: "running:healthy" },
      { uuid: "runner-shared-ci", name: "shared-ci (ci-cpx32)", type: "action-runner", status: "running:healthy" },
      { uuid: "runner-usage-ci", name: "usage-ci (ci-cpx32)", type: "action-runner", status: "running:healthy" },
      { uuid: "runner-github-runner", name: "github-runner (prod host)", type: "action-runner", status: "running:healthy" },
    ],
    metrics: emptyMetrics(),
    asOf: new Date().toISOString(),
  };
}

async function refreshRemoteMetrics(
  configuration: ReturnType<typeof readConfiguration>,
  isProd: boolean,
  previous: ServerMetricsCacheEntry | undefined,
): Promise<ServerMetricsPayload> {
  const refreshedAt = Date.now();
  const result = await loadRemoteMetrics(configuration, isProd, refreshedAt);

  if (
    previous
    && previous.discardAt > refreshedAt
    && result.attemptedProviderReads > 0
    && result.successfulProviderReads === 0
  ) {
    const failureWarnings = result.payload.warnings ?? [];
    const payload: ServerMetricsPayload = {
      ...previous.payload,
      degraded: true,
      stale: true,
      error: "Infrastructure providers are unavailable; showing the last successful snapshot.",
      warnings: uniqueStrings([
        ...(previous.payload.warnings ?? []),
        ...failureWarnings,
        "The displayed infrastructure snapshot is stale.",
      ]),
    };
    serverMetricsRuntime.remoteCache = {
      key: previous.key,
      payload,
      expiresAt: refreshedAt + SERVER_METRICS_FAILURE_RETRY_MS,
      discardAt: previous.discardAt,
    };
    return withCacheAge(payload, refreshedAt);
  }

  if (
    previous
    && previous.discardAt > refreshedAt
    && result.hetznerMetricsReadFailed
  ) {
    const payload: ServerMetricsPayload = {
      ...result.payload,
      metrics: previous.payload.metrics,
      asOf: previous.payload.asOf,
      degraded: true,
      stale: true,
      error: "Hetzner metrics are unavailable; showing the last successful metric series.",
      warnings: uniqueStrings([
        ...(result.payload.warnings ?? []),
        "The displayed infrastructure metrics are stale.",
      ]),
    };
    serverMetricsRuntime.remoteCache = {
      key: previous.key,
      payload,
      expiresAt: refreshedAt + SERVER_METRICS_FAILURE_RETRY_MS,
      discardAt: previous.discardAt,
    };
    return withCacheAge(payload, refreshedAt);
  }

  const ttl = result.attemptedProviderReads > 0 && result.successfulProviderReads === 0
    ? SERVER_METRICS_FAILURE_RETRY_MS
    : SERVER_METRICS_CACHE_TTL_MS;
  serverMetricsRuntime.remoteCache = {
    key: [
      isProd ? "production" : "remote",
      configuration.states.hetzner,
      configuration.hetznerServerId ?? "",
      configuration.states.coolify,
      configuration.coolifyServerUuid ?? "",
    ].join(":"),
    payload: result.payload,
    expiresAt: refreshedAt + ttl,
    discardAt: refreshedAt + SERVER_METRICS_MAX_STALE_MS,
  };
  return result.payload;
}

async function loadRemoteMetrics(
  configuration: ReturnType<typeof readConfiguration>,
  isProd: boolean,
  refreshedAt: number,
): Promise<RefreshResult> {
  const warnings: string[] = [];
  const providerErrors: string[] = [];
  let attemptedProviderReads = 0;
  let successfulProviderReads = 0;
  let hetznerMetricsReadFailed = false;

  if (configuration.states.hetzner === "partial") {
    warnings.push("Hetzner configuration is incomplete; both API token and server ID are required.");
  } else if (configuration.states.hetzner === "missing") {
    warnings.push("Hetzner is not configured.");
  }
  if (configuration.states.coolify === "partial") {
    warnings.push("Coolify configuration is incomplete; both API token and server UUID are required.");
  } else if (configuration.states.coolify === "missing") {
    warnings.push("Coolify is not configured.");
  }

  let coolifyServerFetch: ProviderFetchResult = {};
  let coolifyResourcesFetch: ProviderFetchResult = {};
  if (
    configuration.states.coolify === "configured"
    && configuration.coolifyToken
    && configuration.coolifyServerUuid
  ) {
    const headers = {
      Authorization: `Bearer ${configuration.coolifyToken}`,
      "User-Agent": "Socratic.Trade infrastructure monitor",
      Accept: "application/json",
    };
    const serverUrl = `https://host.jays.services/api/v1/servers/${configuration.coolifyServerUuid}`;
    attemptedProviderReads += 2;
    [coolifyServerFetch, coolifyResourcesFetch] = await Promise.all([
      fetchProviderJson("Coolify server metadata", serverUrl, headers),
      fetchProviderJson("Coolify resources", `${serverUrl}/resources`, headers),
    ]);
    successfulProviderReads += Number(coolifyServerFetch.payload !== undefined);
    successfulProviderReads += Number(coolifyResourcesFetch.payload !== undefined);
  }

  let hetznerServerFetch: ProviderFetchResult = {};
  let hetznerMetricsFetch: ProviderFetchResult = {};
  if (
    configuration.states.hetzner === "configured"
    && configuration.hetznerToken
    && configuration.hetznerServerId
  ) {
    const headers = {
      Authorization: `Bearer ${configuration.hetznerToken}`,
      Accept: "application/json",
    };
    const serverUrl = `https://api.hetzner.cloud/v1/servers/${configuration.hetznerServerId}`;
    const start = new Date(refreshedAt - 60 * 60 * 1000).toISOString();
    const end = new Date(refreshedAt).toISOString();
    const metricsUrl = `${serverUrl}/metrics?type=cpu&type=disk&type=network&start=${start}&end=${end}`;
    attemptedProviderReads += 2;
    [hetznerServerFetch, hetznerMetricsFetch] = await Promise.all([
      fetchProviderJson("Hetzner server metadata", serverUrl, headers),
      fetchProviderJson("Hetzner metrics", metricsUrl, headers),
    ]);
    if (
      hetznerMetricsFetch.payload !== undefined
      && !asRecord(asRecord(asRecord(hetznerMetricsFetch.payload)?.metrics)?.time_series)
    ) {
      hetznerMetricsFetch = {
        error: "Hetzner metrics returned an invalid metrics envelope.",
      };
    }
    hetznerMetricsReadFailed = hetznerMetricsFetch.payload === undefined;
    successfulProviderReads += Number(hetznerServerFetch.payload !== undefined);
    successfulProviderReads += Number(hetznerMetricsFetch.payload !== undefined);
  }

  for (const error of [
    coolifyServerFetch.error,
    coolifyResourcesFetch.error,
    hetznerServerFetch.error,
    hetznerMetricsFetch.error,
  ]) {
    if (error) providerErrors.push(error);
  }

  const coolifyServer = asRecord(coolifyServerFetch.payload);
  const coolifyMeta = asRecord(coolifyServer?.server_metadata);
  const normalizedHetzner = hetznerServerFetch.payload === undefined
    ? { server: {}, warnings: [] as string[] }
    : normalizeHetznerServerResponse(hetznerServerFetch.payload);
  const normalizedResources = coolifyResourcesFetch.payload === undefined
    ? { resources: [], warnings: [] as string[] }
    : normalizeCoolifyResources(coolifyResourcesFetch.payload);
  const coreCount = normalizedHetzner.server.cpus ?? readPositiveNumber(coolifyMeta?.cpus);
  const rawTimeSeries = asRecord(asRecord(hetznerMetricsFetch.payload)?.metrics)?.time_series;
  const parsedMetrics = parseHetznerTimeSeries(rawTimeSeries, coreCount);

  warnings.push(
    ...providerErrors,
    ...normalizedHetzner.warnings,
    ...normalizedResources.warnings,
    ...parsedMetrics.warnings,
  );

  const actionRunners = await getActionRunners();
  const allResources = [...normalizedResources.resources, ...actionRunners];

  const hostInfo = compactRecord({
    name: normalizedHetzner.server.name ?? readText(coolifyServer?.name),
    status: normalizedHetzner.server.status,
    os: readText(coolifyMeta?.os),
    cpus: coreCount,
    memoryTotalBytes: normalizedHetzner.server.memoryGb
      ? normalizedHetzner.server.memoryGb * 1024 * 1024 * 1024
      : readPositiveNumber(coolifyMeta?.memory_bytes),
    memoryFreeBytes: readPositiveNumber(coolifyMeta?.memory_free_bytes),
    uptimeSeconds: readPositiveNumber(coolifyMeta?.uptime_seconds),
    serverType: normalizedHetzner.server.serverType,
    location: normalizedHetzner.server.location,
    ip: normalizedHetzner.server.ip,
  });
  if (!hostInfo.status) hostInfo.status = "unknown";

  const finalWarnings = uniqueStrings(warnings);
  const degraded = finalWarnings.length > 0;
  return {
    attemptedProviderReads,
    successfulProviderReads,
    hetznerMetricsReadFailed,
    payload: {
      isProd,
      usesLocalHost: false,
      degraded,
      stale: false,
      cacheAgeSeconds: 0,
      configuration: configuration.states,
      hostInfo,
      resources: allResources,
      metrics: parsedMetrics.metrics,
      asOf: new Date(refreshedAt).toISOString(),
      ...(providerErrors.length > 0
        ? { error: "One or more infrastructure providers could not be queried." }
        : {}),
      ...(finalWarnings.length > 0 ? { warnings: finalWarnings } : {}),
    },
  };
}

function parseHetznerTimeSeries(timeSeries: unknown, coreCount: number | undefined): {
  metrics: Record<string, ServerMetricsMetricValue[]>;
  warnings: string[];
} {
  const series = asRecord(timeSeries) ?? {};
  let omittedSamples = 0;
  const result = emptyMetrics();

  const getValues = (key: string): ServerMetricsMetricValue[] => {
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

  const keys = Object.keys(series);
  const cpuKey = keys.find((key) => key.startsWith("cpu")) ?? "cpu";
  const diskReadKey = keys.find((key) => key.includes("bandwidth.read")) ?? "disk.0.bandwidth.read";
  const diskWriteKey = keys.find((key) => key.includes("bandwidth.write")) ?? "disk.0.bandwidth.write";
  const netRxKey = keys.find((key) => key.includes("bandwidth.in") || key.includes("bandwidth.rx"))
    ?? "network.0.bandwidth.in";
  const netTxKey = keys.find((key) => key.includes("bandwidth.out") || key.includes("bandwidth.tx"))
    ?? "network.0.bandwidth.out";

  const rawCpu = getValues(cpuKey);
  result.cpu = coreCount
    ? rawCpu.map((point) => ({ ...point, value: point.value / coreCount }))
    : [];
  result.diskRead = getValues(diskReadKey);
  result.diskWrite = getValues(diskWriteKey);
  result.networkRx = getValues(netRxKey);
  result.networkTx = getValues(netTxKey);

  const warnings: string[] = [];
  if (rawCpu.length > 0 && !coreCount) {
    warnings.push("Hetzner aggregate CPU metrics were omitted because the server core count was unavailable.");
  }
  if (omittedSamples > 0) {
    warnings.push(`Hetzner metrics contained ${omittedSamples} malformed samples that were omitted.`);
  }
  return { metrics: result, warnings };
}

interface ProviderFetchResult {
  payload?: unknown;
  error?: string;
}

async function fetchProviderJson(
  label: string,
  url: string,
  headers: Record<string, string>,
): Promise<ProviderFetchResult> {
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { error: `${label} returned HTTP ${response.status}.` };
    try {
      return { payload: await readBoundedJson(response, MAX_PROVIDER_RESPONSE_BYTES) };
    } catch {
      return { error: `${label} returned invalid or oversized JSON.` };
    }
  } catch {
    return { error: `${label} was unavailable.` };
  }
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("response_too_large");
  if (!response.body) throw new Error("empty_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function toFiniteMetricNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function emptyMetrics(): Record<string, ServerMetricsMetricValue[]> {
  return {
    cpu: [],
    diskRead: [],
    diskWrite: [],
    networkRx: [],
    networkTx: [],
  };
}

function compactRecord(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function withCacheAge(payload: ServerMetricsPayload, now: number): ServerMetricsPayload {
  const asOf = Date.parse(payload.asOf);
  return {
    ...payload,
    cacheAgeSeconds: Number.isFinite(asOf) ? Math.max(0, Math.floor((now - asOf) / 1000)) : 0,
  };
}

function jsonResponse(payload: ServerMetricsPayload) {
  return NextResponse.json(payload, {
    status: 200,
    headers: { "Cache-Control": "private, no-store" },
  });
}
