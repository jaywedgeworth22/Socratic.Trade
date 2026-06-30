import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-policy-notify-${randomUUID()}.db`)}`;
});

describe("policy notification event settings", () => {
  it("persists provider_degraded when Settings saves enabled notification events", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const { getPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");

    const response = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          notificationSettings: {
            ...getPolicy(DEFAULT_REQUEST_USER_ID).notificationSettings,
            enabledEvents: ["fill", "provider_degraded", "limit_order_stale", "not_real"]
          }
        })
      })
    );

    expect(response.status).toBe(200);
    const policy = await response.json();
    expect(policy.notificationSettings.enabledEvents).toEqual(["fill", "provider_degraded", "limit_order_stale"]);
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).notificationSettings.enabledEvents).toEqual(["fill", "provider_degraded", "limit_order_stale"]);
  });
});
