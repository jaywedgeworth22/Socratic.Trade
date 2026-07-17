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
    // Keyed-provider backstop (owner directive 2026-07-07): a chosen model's provider must have a
    // resolvable key or the PUT 400s on THAT first — seed one so this test reaches the reasoning rule.
    const { upsertUserApiKey } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");
    upsertUserApiKey(DEFAULT_REQUEST_USER_ID, "openrouter", "sk-test", "test fixture");

    const response = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          llmModel: "openai/gpt-5.5",
          llmReasoningEffort: "high"
        })
      })
    );

    expect(response.status).toBe(400);
    const proposerMessage = await response.text();
    expect(proposerMessage).toContain("gpt-5.5 with high reasoning is disabled");
    // Per-team split (2026-07-10): the rejection names WHICH team's combo violated.
    expect(proposerMessage).toContain("Green Team");

    // Reviewer violation via the FALLBACK: no explicit redTeamReasoningEffort, so the reviewer
    // inherits the proposer's high — and the reviewer model is the gpt-5.5.
    const redTeamResponse = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          llmModel: "gpt-5.4-mini",
          redTeamLlmModel: "openai/gpt-5.5",
          llmReasoningEffort: "high"
        })
      })
    );

    expect(redTeamResponse.status).toBe(400);
    const reviewerMessage = await redTeamResponse.text();
    expect(reviewerMessage).toContain("gpt-5.5 with high reasoning is disabled");
    expect(reviewerMessage).toContain("Red Team");

    // Reviewer violation via its EXPLICIT per-team effort (proposer effort is innocent).
    const explicitReviewerResponse = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          llmModel: "gpt-5.4-mini",
          redTeamLlmModel: "openai/gpt-5.5",
          llmReasoningEffort: "medium",
          redTeamReasoningEffort: "high"
        })
      })
    );
    expect(explicitReviewerResponse.status).toBe(400);
    expect(await explicitReviewerResponse.text()).toContain("Red Team");

    // An explicit reviewer medium RESCUES the fallback: the proposer's high no longer reaches the
    // gpt-5.5 reviewer, and the gpt-5.4-mini proposer may run at high — nothing violates.
    const rescuedResponse = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          llmModel: "gpt-5.4-mini",
          redTeamLlmModel: "openai/gpt-5.5",
          llmReasoningEffort: "high",
          redTeamReasoningEffort: "medium"
        })
      })
    );
    expect(rescuedResponse.status).toBe(200);
    const rescued = await rescuedResponse.json();
    expect(rescued.llmReasoningEffort).toBe("high");
    expect(rescued.redTeamReasoningEffort).toBe("medium");

    // The per-team field gets the same enum validation as the legacy one.
    const badValueResponse = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redTeamReasoningEffort: "extreme" })
      })
    );
    expect(badValueResponse.status).toBe(400);
    expect(await badValueResponse.text()).toContain("redTeamReasoningEffort must be");
  });

  it("does NOT block unrelated saves when the STORED policy already has gpt-5.5 + high reasoning", async () => {
    const { PUT } = await import("../app/api/policy/route");
    const { getPolicy, setPolicy } = await import("../src/lib/db");
    const { DEFAULT_REQUEST_USER_ID } = await import("../src/lib/request-user");

    // Seed a stale stored config directly (bypassing the route): gpt-5.5 + high.
    // Run time already clamps this to medium, so unrelated policy writes must not
    // be rejected because of it (owner-reported bug: saving notification prefs and
    // enabling short selling both failed with the model error).
    setPolicy({ ...getPolicy(DEFAULT_REQUEST_USER_ID), llmModel: "openai/gpt-5.5", llmReasoningEffort: "high" }, DEFAULT_REQUEST_USER_ID);

    const notifyResponse = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notificationSettings: { enabledEvents: ["fill", "kill_switch"] }
        })
      })
    );
    expect(notifyResponse.status).toBe(200);
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).notificationSettings.enabledEvents).toEqual(["fill", "kill_switch"]);

    const shortResponse = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shortSellingEnabled: true })
      })
    );
    expect(shortResponse.status).toBe(200);
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).shortSellingEnabled).toBe(true);
    // The stored model config is untouched by the unrelated saves.
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).llmModel).toBe("openai/gpt-5.5");
    expect(getPolicy(DEFAULT_REQUEST_USER_ID).llmReasoningEffort).toBe("high");

    // But a write that CHANGES the model/effort combo to the disallowed one is still rejected.
    // (Seed a key so the model-changing write passes the keyed-provider backstop and reaches the
    // reasoning rule.)
    const { upsertUserApiKey } = await import("../src/lib/db");
    upsertUserApiKey(DEFAULT_REQUEST_USER_ID, "openrouter", "sk-test", "test fixture");
    const stillRejected = await PUT(
      new Request("http://localhost/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ llmModel: "gpt-5.4-mini", llmReasoningEffort: "high", redTeamLlmModel: "openai/gpt-5.5" })
      })
    );
    expect(stillRejected.status).toBe(400);
    const stillRejectedMessage = await stillRejected.text();
    expect(stillRejectedMessage).toContain("gpt-5.5 with high reasoning is disabled");
    // The gpt-5.5 seat here is the reviewer (inheriting the proposer's high via the fallback).
    expect(stillRejectedMessage).toContain("Red Team");
  });
});
