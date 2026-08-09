import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/admin/server-metrics/route";
import {
  SERVER_METRICS_CACHE_TTL_MS,
  resetServerMetricsCacheForTests,
} from "../src/lib/server-metrics-runtime";
import {
  displayProviderText,
  markServerMetricsSnapshotStale,
  parseServerMetricsEnvelope,
} from "../app/admin/server/server-metrics-client";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_IDENTITY_SOURCES
} from "../src/lib/auth/strip-identity";
import { AUTHENTICATED_EMAIL_HEADER } from "../src/lib/request-user";
import { normalizeCoolifyResources, normalizeHetznerServerResponse } from "../src/lib/server-metrics-shapes";

function reqWithEmail(email?: string): Request {
  const headers: Record<string, string> = {};
  if (email) {
    headers[AUTHENTICATED_EMAIL_HEADER] = email;
    headers[AUTHENTICATED_IDENTITY_SOURCE_HEADER] = AUTHENTICATED_IDENTITY_SOURCES.authJsSession;
  }
  return new Request("https://socratictrade.com/api/admin/server-metrics", { method: "GET", headers });
}

function providerResponse(payload: unknown, status = 200) {
  return Response.json(payload, { status });
}

describe("server-metrics provider shape normalization", () => {
  it("extracts display strings from the real Hetzner server response shape", () => {
    const normalized = normalizeHetznerServerResponse({
      server: {
        name: "ubuntu-8gb-hel1-2",
        status: "running",
        server_type: { name: "cpx32", cores: 4, memory: 8 },
        location: { name: "hel1-dc2" },
        public_net: { ipv4: { ip: "135.181.192.190", blocked: false } },
      },
    });

    expect(normalized).toEqual({
      server: {
        name: "ubuntu-8gb-hel1-2",
        status: "running",
        serverType: "cpx32",
        cpus: 4,
        memoryGb: 8,
        location: "hel1-dc2",
        ip: "135.181.192.190",
      },
      warnings: [],
    });
  });

  it("reports malformed nested values and the client renders diagnostics instead of objects", () => {
    const malformedServerType = { cores: 4 };
    const malformedIpv4 = { blocked: false };
    const normalized = normalizeHetznerServerResponse({
      server: {
        server_type: malformedServerType,
        public_net: { ipv4: malformedIpv4 },
      },
    });

    expect(normalized.server.serverType).toBeUndefined();
    expect(normalized.server.ip).toBeUndefined();
    expect(normalized.warnings).toEqual([
      "Hetzner server_type.name was not a non-empty string.",
      "Hetzner public_net.ipv4.ip was not a non-empty string.",
    ]);
    expect(displayProviderText(malformedServerType, "vps", "server type")).toBe("Invalid server type");
    expect(displayProviderText(malformedIpv4, "127.0.0.1", "server IP")).toBe("Invalid server IP");
  });

  it("omits malformed Coolify resources while retaining valid services and backup tasks", () => {
    const normalized = normalizeCoolifyResources([
      { uuid: "app-1", name: "socratic-trade-prod", type: "application", status: "running:healthy" },
      { uuid: "app-2", name: { rendered: "bad" }, type: "application", status: { state: "running" } },
      { uuid: "app-3", name: "usage monitor backups", type: "backup", status: "running:healthy" },
    ]);

    expect(normalized.resources).toEqual([
      { uuid: "app-1", name: "socratic-trade-prod", type: "application", status: "running:healthy" },
      { uuid: "app-3", name: "usage monitor backups", type: "backup", status: "running:healthy" },
    ]);
    expect(normalized.warnings).toEqual([
      "Coolify resource at index 1 had malformed display fields and was omitted.",
    ]);
  });

  it("bounds Coolify normalization work and warning expansion", () => {
    const normalized = normalizeCoolifyResources(new Array(100_000).fill(null));

    expect(normalized.resources).toEqual([]);
    expect(normalized.warnings).toHaveLength(22);
    expect(normalized.warnings.at(-2)).toBe("480 additional malformed Coolify resources were omitted.");
    expect(normalized.warnings.at(-1)).toBe(
      "Coolify returned 100000 resources; only the first 500 were processed.",
    );
    expect(JSON.stringify(normalized).length).toBeLessThan(4_096);
  });

  it("validates successful client envelopes and marks retained data stale on transport failure", () => {
    const parsed = parseServerMetricsEnvelope({
      isProd: true,
      usesLocalHost: false,
      degraded: false,
      stale: false,
      cacheAgeSeconds: 2,
      hostInfo: { name: "prod-server" },
      resources: [],
      metrics: {
        cpu: [{ timestamp: 1, value: 10 }],
        diskRead: [],
        diskWrite: [],
        networkRx: [],
        networkTx: [],
      },
      asOf: "2026-07-18T12:00:00.000Z",
    });
    expect(parsed).toMatchObject({ isProd: true, stale: false, cacheAgeSeconds: 2 });
    expect(parseServerMetricsEnvelope({
      ...parsed,
      metrics: { ...parsed?.metrics, cpu: "not-an-array" },
    })).toBeUndefined();
    expect(markServerMetricsSnapshotStale(parsed ?? null, "network failed")).toMatchObject({
      degraded: true,
      stale: true,
      error: "network failed",
    });
  });
});

describe("server-metrics API route", () => {
  beforeEach(() => {
    // The route probes GitHub Actions runners whenever ANY of these tokens resolves — and agent
    // machines now export GH_TOKEN in every shell (fleet keychain standardization, 2026-08-09),
    // which added a 5th fetch and broke every pinned call-count below. Hermetic tests must not
    // inherit machine credentials.
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GITHUB_MCP_TOKEN", "");
  });
  afterEach(() => {
    resetServerMetricsCacheForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("DENIES access for non-admin users in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    
    const res = await GET(reqWithEmail("user@example.com"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("ALLOWS access and returns real local host metadata with empty remote data when not configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    // Leave HETZNER_API_TOKEN etc unset
    vi.stubEnv("HETZNER_API_TOKEN", "");

    const res = await GET(reqWithEmail("admin@example.com"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isProd).toBe(false);
    expect(body.usesLocalHost).toBe(true);
    expect(body.stale).toBe(false);
    expect(body.hostInfo).toBeDefined();
    expect(body.hostInfo.cpus).toBeGreaterThan(0);
    expect(body.resources.length).toBeGreaterThanOrEqual(6);
    expect(body.metrics).toEqual({
      cpu: [],
      diskRead: [],
      diskWrite: [],
      networkRx: [],
      networkTx: [],
    });
  });

  it("ALLOWS access and calls Hetzner/Coolify APIs when configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_METRICS_TARGET_ENVIRONMENT", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "mock-coolify-token");
    vi.stubEnv("COOLIFY_SERVER_UUID", "mock-coolify-uuid");

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("api.hetzner.cloud/v1/servers/12345/metrics")) {
        return Promise.resolve(providerResponse({
            metrics: {
              time_series: {
                cpu: {
                  values: [
                    [1783652400, "351.748098"],
                    [1783652460, null],
                    [1783652520, "not-a-number"],
                  ]
                },
                "disk.0.bandwidth.read": {
                  values: [[1783652400, "1024"]]
                },
                "network.0.bandwidth.in": {
                  values: [[1783652400, "5000"]]
                },
                "network.0.bandwidth.out": {
                  values: [[1783652400, "2500"]]
                }
              }
            }
          }));
      }
      if (url.includes("api.hetzner.cloud/v1/servers/12345")) {
        return Promise.resolve(providerResponse({
            server: {
              name: "prod-server",
              status: "running",
              server_type: { name: "cx33", cores: 4, memory: 8 },
              location: { name: "hel1" },
              public_net: { ipv4: { ip: "135.181.192.190", blocked: false } }
            }
          }));
      }
      if (url.includes("api/v1/servers/mock-coolify-uuid/resources")) {
        return Promise.resolve(providerResponse([
            { uuid: "app-1", name: "socratic-trade-prod", type: "application", status: "running:healthy" },
            { uuid: "app-2", name: { bad: true }, type: "application", status: { state: "running" } }
          ]));
      }
      if (url.includes("api/v1/servers/mock-coolify-uuid")) {
        return Promise.resolve(providerResponse({
            name: "prod-server",
            server_metadata: {
              os: "Ubuntu 26.04",
              cpus: 4,
              memory_bytes: 8192000
            }
          }));
      }
      return Promise.reject(new Error(`Unhandled URL: ${url}`));
    });

    vi.stubGlobal("fetch", mockFetch);

    const res = await GET(reqWithEmail("admin@example.com"));
    expect(res.status).toBe(200);
    const body = await res.json();
    
    expect(body.isProd).toBe(true);
    expect(body.usesLocalHost).toBe(false);
    expect(body.stale).toBe(false);
    expect(body.hostInfo.name).toBe("prod-server");
    expect(body.hostInfo.cpus).toBe(4);
    expect(body.hostInfo.serverType).toBe("cx33");
    expect(body.hostInfo.ip).toBe("135.181.192.190");
    expect(body.warnings).toEqual([
      "Coolify resource at index 1 had malformed display fields and was omitted.",
      "Hetzner metrics contained 2 malformed samples that were omitted.",
    ]);
    expect(body.resources.length).toBeGreaterThanOrEqual(7);
    expect(body.resources[0].name).toBe("socratic-trade-prod");
    expect(body.metrics.cpu[0].value).toBeCloseTo(87.9370245);
    expect(body.metrics.cpu).toHaveLength(1);
    expect(body.metrics.diskRead[0].value).toBe(1024);
    expect(body.metrics.networkRx[0].value).toBe(5000);
    expect(body.metrics.networkTx[0].value).toBe(2500);

    const cachedRes = await GET(reqWithEmail("admin@example.com"));
    expect(cachedRes.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("does not infer the monitored target is production from this app runtime", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "");
    vi.stubEnv("COOLIFY_SERVER_UUID", "");
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => Promise.resolve(providerResponse(
      url.includes("/metrics")
        ? { metrics: { time_series: {} } }
        : { server: { name: "monitored-host", status: "running", server_type: { cores: 4 } } },
    ))));

    const res = await GET(reqWithEmail("admin@example.com"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.usesLocalHost).toBe(false);
    expect(body.isProd).toBe(false);
  });

  it("returns HTTP 200 with valid data when one provider endpoint fails", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "mock-coolify-token");
    vi.stubEnv("COOLIFY_SERVER_UUID", "mock-coolify-uuid");

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("/resources")) return Promise.resolve(providerResponse({}, 503));
      if (url.includes("/metrics")) {
        return Promise.resolve(providerResponse({
          metrics: { time_series: { cpu: { values: [[1783652400, "40"]] } } },
        }));
      }
      if (url.includes("api.hetzner.cloud")) {
        return Promise.resolve(providerResponse({
          server: { name: "verified-host", status: "running", server_type: { name: "cx22" } },
        }));
      }
      return Promise.resolve(providerResponse({ name: "coolify-host", server_metadata: {} }));
    }));

    const res = await GET(reqWithEmail("admin@example.com"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.degraded).toBe(true);
    expect(body.hostInfo.name).toBe("verified-host");
    expect(body.resources.length).toBeGreaterThanOrEqual(6);
    expect(body.metrics.cpu).toEqual([]);
    expect(body.warnings).toEqual(expect.arrayContaining([
      "Coolify resources returned HTTP 503.",
      "Hetzner aggregate CPU metrics were omitted because the server core count was unavailable.",
    ]));
  });

  it("bounds provider response bodies while retaining valid sibling data", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "");
    vi.stubEnv("COOLIFY_SERVER_UUID", "");
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("/metrics")) {
        return Promise.resolve(new Response("{}", {
          status: 200,
          headers: { "Content-Length": String(600 * 1024), "Content-Type": "application/json" },
        }));
      }
      return Promise.resolve(providerResponse({
        server: { name: "verified-host", status: "running", server_type: { cores: 4 } },
      }));
    }));

    const response = await GET(reqWithEmail("admin@example.com"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.degraded).toBe(true);
    expect(body.hostInfo.name).toBe("verified-host");
    expect(body.warnings).toContain("Hetzner metrics returned invalid or oversized JSON.");
  });

  it.each([
    ["missing time_series", { metrics: {} }],
    ["non-object time_series", { metrics: { time_series: [] } }],
  ])("rejects a Hetzner metrics envelope with %s", async (_description, malformedPayload) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "");
    vi.stubEnv("COOLIFY_SERVER_UUID", "");
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => Promise.resolve(providerResponse(
      url.includes("/metrics")
        ? malformedPayload
        : { server: { name: "verified-host", status: "running", server_type: { cores: 4 } } },
    ))));

    const response = await GET(reqWithEmail("admin@example.com"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.degraded).toBe(true);
    expect(body.metrics).toEqual({
      cpu: [],
      diskRead: [],
      diskWrite: [],
      networkRx: [],
      networkTx: [],
    });
    expect(body.warnings).toContain("Hetzner metrics returned an invalid metrics envelope.");
  });

  it("retains the last metric series when Hetzner returns a malformed metrics envelope", async () => {
    vi.useFakeTimers();
    const initialTime = new Date("2026-07-18T12:00:00.000Z");
    vi.setSystemTime(initialTime);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_METRICS_TARGET_ENVIRONMENT", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "");
    vi.stubEnv("COOLIFY_SERVER_UUID", "");

    const mockFetch = vi.fn().mockImplementation((url: string) => Promise.resolve(providerResponse(
      url.includes("/metrics")
        ? { metrics: { time_series: { cpu: { values: [[1783652400, "40"]] } } } }
        : { server: { name: "verified-host", status: "running", server_type: { cores: 4 } } },
    )));
    vi.stubGlobal("fetch", mockFetch);

    const initial = await GET(reqWithEmail("admin@example.com"));
    const initialBody = await initial.json();
    expect(initialBody.metrics.cpu).toEqual([{ timestamp: 1783652400, value: 10 }]);

    vi.setSystemTime(new Date(initialTime.getTime() + SERVER_METRICS_CACHE_TTL_MS + 1));
    mockFetch.mockImplementation((url: string) => Promise.resolve(providerResponse(
      url.includes("/metrics")
        ? { metrics: {} }
        : { server: { name: "verified-host", status: "running", server_type: { cores: 4 } } },
    )));

    const stale = await GET(reqWithEmail("admin@example.com"));
    const staleBody = await stale.json();
    expect(stale.status).toBe(200);
    expect(staleBody.degraded).toBe(true);
    expect(staleBody.stale).toBe(true);
    expect(staleBody.asOf).toBe(initialBody.asOf);
    expect(staleBody.metrics.cpu).toEqual(initialBody.metrics.cpu);
    expect(staleBody.warnings).toEqual(expect.arrayContaining([
      "Hetzner metrics returned an invalid metrics envelope.",
      "The displayed infrastructure metrics are stale.",
    ]));
  });

  it("does not misreport partial production configuration as the local host", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_METRICS_TARGET_ENVIRONMENT", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "token-without-server-uuid");
    vi.stubEnv("COOLIFY_SERVER_UUID", "");

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/metrics")) {
        return Promise.resolve(providerResponse({ metrics: { time_series: {} } }));
      }
      return Promise.resolve(providerResponse({
        server: {
          name: "prod-server",
          status: "running",
          server_type: { name: "cx33", cores: 4 },
        },
      }));
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await GET(reqWithEmail("admin@example.com"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.isProd).toBe(true);
    expect(body.usesLocalHost).toBe(false);
    expect(body.degraded).toBe(true);
    expect(body.configuration).toEqual({ hetzner: "configured", coolify: "partial" });
    expect(body.hostInfo.name).toBe("prod-server");
    expect(body.hostInfo.uptimeSeconds).toBeUndefined();
    expect(body.warnings).toContain(
      "Coolify configuration is incomplete; both API token and server UUID are required.",
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps unconfigured production values unavailable instead of using process host data", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_METRICS_TARGET_ENVIRONMENT", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "");
    vi.stubEnv("HETZNER_SERVER_ID", "");
    vi.stubEnv("COOLIFY_API_TOKEN", "");
    vi.stubEnv("COOLIFY_SERVER_UUID", "");
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const res = await GET(reqWithEmail("admin@example.com"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.isProd).toBe(true);
    expect(body.usesLocalHost).toBe(false);
    expect(body.degraded).toBe(true);
    expect(body.hostInfo).toEqual({ status: "unknown" });
    expect(body.metrics.cpu).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns an explicit degraded receipt without fabricated host data on provider failures", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_METRICS_TARGET_ENVIRONMENT", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "mock-coolify-token");
    vi.stubEnv("COOLIFY_SERVER_UUID", "mock-coolify-uuid");

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/resources")) return Promise.resolve(providerResponse({}, 401));
      if (url.includes("api.hetzner.cloud") && url.includes("/metrics")) {
        return Promise.reject(new Error("network unavailable"));
      }
      return Promise.resolve(providerResponse({}, 403));
    });
    vi.stubGlobal("fetch", mockFetch);

    const res = await GET(reqWithEmail("admin@example.com"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.isProd).toBe(true);
    expect(body.degraded).toBe(true);
    expect(body.error).toBe("One or more infrastructure providers could not be queried.");
    expect(body.hostInfo.status).toBe("unknown");
    expect(body.resources.length).toBeGreaterThanOrEqual(6);
    expect(body.metrics).toEqual({
      cpu: [],
      diskRead: [],
      diskWrite: [],
      networkRx: [],
      networkTx: [],
    });
    expect(body.warnings).toEqual(expect.arrayContaining([
      "Coolify server metadata returned HTTP 403.",
      "Coolify resources returned HTTP 401.",
      "Hetzner server metadata returned HTTP 403.",
      "Hetzner metrics was unavailable.",
    ]));
    expect(JSON.stringify(body)).not.toContain("135.181.192.190");
    expect(JSON.stringify(body)).not.toContain("hel1");
  });

  it("single-flights concurrent dashboard refreshes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_METRICS_TARGET_ENVIRONMENT", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "mock-coolify-token");
    vi.stubEnv("COOLIFY_SERVER_UUID", "mock-coolify-uuid");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      await gate;
      if (url.includes("/resources")) return providerResponse([]);
      if (url.includes("/metrics")) return providerResponse({ metrics: { time_series: {} } });
      if (url.includes("api.hetzner.cloud")) {
        return providerResponse({ server: { status: "running", server_type: { cores: 4 } } });
      }
      return providerResponse({ server_metadata: { cpus: 4 } });
    });
    vi.stubGlobal("fetch", mockFetch);

    const first = GET(reqWithEmail("admin@example.com"));
    const second = GET(reqWithEmail("admin@example.com"));
    await Promise.resolve();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    release();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("serves a bounded stale snapshot when a refresh loses all providers", async () => {
    vi.useFakeTimers();
    const initialTime = new Date("2026-07-18T12:00:00.000Z");
    vi.setSystemTime(initialTime);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SERVER_METRICS_TARGET_ENVIRONMENT", "production");
    vi.stubEnv("ADMIN_USER_EMAILS", "admin@example.com");
    vi.stubEnv("HETZNER_API_TOKEN", "mock-hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "12345");
    vi.stubEnv("COOLIFY_API_TOKEN", "mock-coolify-token");
    vi.stubEnv("COOLIFY_SERVER_UUID", "mock-coolify-uuid");

    const healthyFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/resources")) {
        return Promise.resolve(providerResponse([
          { uuid: "app-1", name: "socratic-trade-prod", type: "application", status: "running:healthy" },
        ]));
      }
      if (url.includes("/metrics")) {
        return Promise.resolve(providerResponse({
          metrics: {
            time_series: {
              cpu: { values: [[1783652400, "40"]] },
              "disk.0.bandwidth.read": { values: [[1783652400, "1024"]] },
              "disk.0.bandwidth.write": { values: [[1783652400, "2048"]] },
              "network.0.bandwidth.in": { values: [[1783652400, "4096"]] },
              "network.0.bandwidth.out": { values: [[1783652400, "8192"]] },
            },
          },
        }));
      }
      if (url.includes("api.hetzner.cloud")) {
        return Promise.resolve(providerResponse({
          server: { name: "last-known-host", status: "running", server_type: { cores: 4 } },
        }));
      }
      return Promise.resolve(providerResponse({ server_metadata: { cpus: 4 } }));
    });
    vi.stubGlobal("fetch", healthyFetch);
    const initial = await GET(reqWithEmail("admin@example.com"));
    const initialBody = await initial.json();

    vi.setSystemTime(new Date(initialTime.getTime() + SERVER_METRICS_CACHE_TTL_MS + 1));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("provider outage")));
    const stale = await GET(reqWithEmail("admin@example.com"));
    const staleBody = await stale.json();

    expect(stale.status).toBe(200);
    expect(staleBody.stale).toBe(true);
    expect(staleBody.degraded).toBe(true);
    expect(staleBody.asOf).toBe(initialBody.asOf);
    expect(staleBody.hostInfo.name).toBe("last-known-host");
    expect(staleBody.resources).toEqual(initialBody.resources);
    expect(staleBody.metrics).toEqual(initialBody.metrics);
    expect(staleBody.cacheAgeSeconds).toBeGreaterThanOrEqual(120);
    expect(staleBody.error).toContain("last successful snapshot");

    vi.setSystemTime(new Date(initialTime.getTime() + 10 * 60_000 + 1));
    const expired = await GET(reqWithEmail("admin@example.com"));
    const expiredBody = await expired.json();
    expect(expired.status).toBe(200);
    expect(expiredBody.stale).toBe(false);
    expect(expiredBody.hostInfo).toEqual({ status: "unknown" });
    expect(expiredBody.asOf).not.toBe(initialBody.asOf);
  });
});
