import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/admin/server-metrics/route";
import { AUTHENTICATED_EMAIL_HEADER } from "../src/lib/request-user";

function reqWithEmail(email?: string): Request {
  const headers: Record<string, string> = {};
  if (email) headers[AUTHENTICATED_EMAIL_HEADER] = email;
  return new Request("https://socratictrade.com/api/admin/server-metrics", { method: "GET", headers });
}

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

  it("ALLOWS access and returns local mock metrics when not configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    // Leave HETZNER_API_TOKEN etc unset
    vi.stubEnv("HETZNER_API_TOKEN", "");

    const res = await GET(reqWithEmail("admin@example.com"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isProd).toBe(false);
    expect(body.hostInfo).toBeDefined();
    expect(body.hostInfo.cpus).toBeGreaterThan(0);
    expect(body.resources.length).toBeGreaterThan(0);
    expect(body.metrics.cpu.length).toBeGreaterThan(0);
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
        return Promise.resolve({
          json: () => Promise.resolve({
            metrics: {
              time_series: {
                cpu: {
                  values: [[1783652400, "12.34"]]
                },
                "disk.0.bandwidth.read": {
                  values: [[1783652400, "1024"]]
                },
                "network.0.bandwidth.rx": {
                  values: [[1783652400, "5000"]]
                }
              }
            }
          })
        });
      }
      if (url.includes("api.hetzner.cloud/v1/servers/12345")) {
        return Promise.resolve({
          json: () => Promise.resolve({
            server: {
              name: "prod-server",
              status: "running",
              server_type: "cx33",
              datacenter: { name: "hel1" }
            }
          })
        });
      }
      if (url.includes("api/v1/servers/mock-coolify-uuid/resources")) {
        return Promise.resolve({
          json: () => Promise.resolve([
            { uuid: "app-1", name: "socratic-trade-prod", type: "application", status: "running:healthy" }
          ])
        });
      }
      if (url.includes("api/v1/servers/mock-coolify-uuid")) {
        return Promise.resolve({
          json: () => Promise.resolve({
            name: "prod-server",
            server_metadata: {
              os: "Ubuntu 26.04",
              cpus: 4,
              memory_bytes: 8192000
            }
          })
        });
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
    expect(body.resources[0].name).toBe("socratic-trade-prod");
    expect(body.metrics.cpu[0].value).toBe(12.34);
    expect(body.metrics.diskRead[0].value).toBe(1024);
    expect(body.metrics.networkRx[0].value).toBe(5000);
  });
});
