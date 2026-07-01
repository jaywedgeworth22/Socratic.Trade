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

  it("rejects gpt-5.5 high reasoning for interactive strategy runs", async () => {
    const { PUT } = await import("../app/api/policy/route");

    const response = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          llmModel: "gpt-5.5",
          llmReasoningEffort: "high"
        })
      })
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("gpt-5.5 with high reasoning is disabled");

    const redTeamResponse = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          llmModel: "gpt-5.4-mini",
          redTeamLlmModel: "gpt-5.5",
          llmReasoningEffort: "high"
        })
      })
    );

    expect(redTeamResponse.status).toBe(400);
    expect(await redTeamResponse.text()).toContain("gpt-5.5 with high reasoning is disabled");
  });
});
