import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/admin/server-metrics/route";
import { displayProviderText } from "../app/admin/server/server-metrics-client";
import { AUTHENTICATED_EMAIL_HEADER } from "../src/lib/request-user";
import { normalizeCoolifyResources, normalizeHetznerServerResponse } from "../src/lib/server-metrics-shapes";

function reqWithEmail(email?: string): Request {
  const headers: Record<string, string> = {};
  if (email) headers[AUTHENTICATED_EMAIL_HEADER] = email;
  return new Request("https://socratictrade.com/api/admin/server-metrics", { method: "GET", headers });
}

function providerResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
  };
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

  it("omits malformed Coolify resources and returns string-only display fields", () => {
    const normalized = normalizeCoolifyResources([
      { uuid: "app-1", name: "socratic-trade-prod", type: "application", status: "running:healthy" },
      { uuid: "app-2", name: { rendered: "bad" }, type: "application", status: { state: "running" } },
    ]);

    expect(normalized.resources).toEqual([
      { uuid: "app-1", name: "socratic-trade-prod", type: "application", status: "running:healthy" },
    ]);
    expect(normalized.warnings).toEqual([
      "Coolify resource at index 1 had malformed display fields and was omitted.",
    ]);
  });
});

describe("server-metrics API route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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
    // Leave HETZNER_API_TOKEN etc unset
    vi.stubEnv("HETZNER_API_TOKEN", "");

    const res = await GET(reqWithEmail("admin@example.com"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isProd).toBe(false);
    expect(body.hostInfo).toBeDefined();
    expect(body.hostInfo.cpus).toBeGreaterThan(0);
    expect(body.resources).toEqual([]);
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
                    [1783652400, "12.34"],
                    [1783652460, null],
                    [1783652520, "not-a-number"],
                  ]
                },
                "disk.0.bandwidth.read": {
                  values: [[1783652400, "1024"]]
                },
                "network.0.bandwidth.rx": {
                  values: [[1783652400, "5000"]]
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
    expect(body.hostInfo.name).toBe("prod-server");
    expect(body.hostInfo.cpus).toBe(4);
    expect(body.hostInfo.serverType).toBe("cx33");
    expect(body.hostInfo.ip).toBe("135.181.192.190");
    expect(body.warnings).toEqual([
      "Coolify resource at index 1 had malformed display fields and was omitted.",
      "Hetzner metrics contained 2 malformed samples that were omitted.",
    ]);
    expect(body.resources).toHaveLength(1);
    expect(body.resources[0].name).toBe("socratic-trade-prod");
    expect(body.metrics.cpu[0].value).toBe(12.34);
    expect(body.metrics.cpu).toHaveLength(1);
    expect(body.metrics.diskRead[0].value).toBe(1024);
    expect(body.metrics.networkRx[0].value).toBe(5000);
  });

  it("returns an explicit degraded receipt without fabricated host data on provider failures", async () => {
    vi.stubEnv("NODE_ENV", "production");
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
    expect(res.status).toBe(502);
    const body = await res.json();

    expect(body.isProd).toBe(true);
    expect(body.degraded).toBe(true);
    expect(body.error).toBe("One or more infrastructure providers could not be queried.");
    expect(body.hostInfo).toEqual({ status: "unknown" });
    expect(body.resources).toEqual([]);
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
});
