import { describe, expect, it } from "vitest";
import { isApiKeyPaused, setApiKeyPaused, resolveApiKeyWithSource, LOCAL_USER } from "../src/lib/db-api-keys";

describe("API Key Pause/Resume and Dynamic Fallback", () => {
  it("toggles key pause state correctly", () => {
    const service = "test_service_pause";
    expect(isApiKeyPaused(LOCAL_USER, service)).toBe(false);

    setApiKeyPaused(LOCAL_USER, service, true);
    expect(isApiKeyPaused(LOCAL_USER, service)).toBe(true);

    setApiKeyPaused(LOCAL_USER, service, false);
    expect(isApiKeyPaused(LOCAL_USER, service)).toBe(false);
  });

  it("forces resolveApiKeyWithSource to return source 'none' when paused", () => {
    const service = "roic";
    setApiKeyPaused(LOCAL_USER, service, true);

    const resolved = resolveApiKeyWithSource(service, LOCAL_USER);
    expect(resolved.source).toBe("none");
    expect(resolved.key).toBeUndefined();

    // Resume key
    setApiKeyPaused(LOCAL_USER, service, false);
  });
});
