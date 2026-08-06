import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearOpenRouterUserModelAvailabilityCache,
  getOpenRouterUserModelAvailability,
  isOpenRouterModelAvailable
} from "../src/lib/openrouter-model-availability";

describe("OpenRouter account model availability", () => {
  afterEach(() => {
    clearOpenRouterUserModelAvailabilityCache();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses the account-filtered model IDs and normalizes catalog names", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "openai/gpt-5.6-sol" }, { id: "deepseek/deepseek-v4-pro" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getOpenRouterUserModelAvailability("test-key", "key-ref");

    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(isOpenRouterModelAvailable("gpt-5.6-sol", result.modelIds)).toBe(true);
    expect(isOpenRouterModelAvailable("deepseek-v4-pro", result.modelIds)).toBe(true);
    expect(isOpenRouterModelAvailable("claude-fable-5", result.modelIds)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/models/user");
  });

  it("fails closed when the availability endpoint is unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));

    await expect(getOpenRouterUserModelAvailability("test-key", "key-ref")).resolves.toEqual({
      status: "unavailable",
      reason: "http_503"
    });
  });
});
