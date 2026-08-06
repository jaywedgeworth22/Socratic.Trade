import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  deleteUserApiKey,
  getUserApiKey,
  listUserApiKeys,
  migrateLocalEnvCredentials,
  resolveApiKeyWithSource,
  resolveLlmCredential,
  upsertUserApiKey,
  DELETED_KEY_TOMBSTONE,
  LOCAL_USER
} from "../src/lib/db-api-keys";

describe("API Key Tombstone Deletion (Ghost Key Prevention)", () => {
  const originalEnvGemini = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    deleteUserApiKey(LOCAL_USER, "gemini");
  });

  afterEach(() => {
    if (originalEnvGemini !== undefined) {
      process.env.GEMINI_API_KEY = originalEnvGemini;
    } else {
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("records a tombstone when a user key is deleted", () => {
    upsertUserApiKey(LOCAL_USER, "gemini", "AIzaSyTest12345");
    expect(getUserApiKey(LOCAL_USER, "gemini")?.apiKey).toBe("AIzaSyTest12345");

    deleteUserApiKey(LOCAL_USER, "gemini");

    const keyAfterDelete = getUserApiKey(LOCAL_USER, "gemini");
    expect(keyAfterDelete?.apiKey).toBe(DELETED_KEY_TOMBSTONE);

    // Active keys list does not expose tombstoned keys
    const activeKeys = listUserApiKeys(LOCAL_USER);
    expect(activeKeys.find((k) => k.service === "gemini")).toBeUndefined();
  });

  it("prevents environment fallback when a key is explicitly deleted/tombstoned", () => {
    process.env.GEMINI_API_KEY = "AIzaSyEnvKey999";

    // Before tombstoning, if no DB key existed, it might resolve env key.
    // Now delete explicitly to place tombstone:
    deleteUserApiKey(LOCAL_USER, "gemini");

    const resolved = resolveApiKeyWithSource("gemini", LOCAL_USER);
    expect(resolved.key).toBeUndefined();
    expect(resolved.source).toBe("none");

    const llmResolved = resolveLlmCredential("gemini", LOCAL_USER);
    expect(llmResolved.key).toBeUndefined();
    expect(llmResolved.source).toBe("none");
  });

  it("prevents migrateLocalEnvCredentials from re-instantiating deleted ghost keys", () => {
    process.env.GEMINI_API_KEY = "AIzaSyEnvKey999";
    deleteUserApiKey(LOCAL_USER, "gemini");

    const result = migrateLocalEnvCredentials();
    expect(result.migrated).not.toContain("gemini");

    const keyState = getUserApiKey(LOCAL_USER, "gemini");
    expect(keyState?.apiKey).toBe(DELETED_KEY_TOMBSTONE);
  });
});
