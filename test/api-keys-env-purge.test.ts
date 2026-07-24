import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  deleteUserApiKey,
  migrateLocalEnvCredentials,
  purgeProcessEnvUserKeys,
  resolveApiKeyWithSource,
  upsertUserApiKey,
  LOCAL_USER
} from "../src/lib/db-api-keys";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `env-purge-${randomUUID()}.db`)}`;
});

describe("process.env API key purging", () => {
  it("purges LLM and user interface keys from process.env on migrateLocalEnvCredentials", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    try {
      migrateLocalEnvCredentials();
      expect(process.env.GEMINI_API_KEY).toBeUndefined();
      expect(process.env.DEEPSEEK_API_KEY).toBeUndefined();
      expect(resolveApiKeyWithSource("gemini", LOCAL_USER)).toMatchObject({
        key: "test-gemini-key",
        source: "user"
      });
    } finally {
      delete process.env.GEMINI_API_KEY;
      delete process.env.DEEPSEEK_API_KEY;
    }
  });

  it("purges process.env when upsertUserApiKey or deleteUserApiKey is called for a per-user credential", () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    try {
      upsertUserApiKey(LOCAL_USER, "openrouter", "custom-or-key");
      expect(process.env.OPENROUTER_API_KEY).toBeUndefined();

      process.env.OPENROUTER_API_KEY = "ghost-or-key";
      deleteUserApiKey(LOCAL_USER, "openrouter");
      expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("purgeProcessEnvUserKeys removes all providable LLM & interface keys from process.env", () => {
    process.env.OPENAI_API_KEY = "test-openai";
    process.env.ANTHROPIC_API_KEY = "test-anthropic";
    process.env.XAI_API_KEY = "test-xai";
    try {
      purgeProcessEnvUserKeys();
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(process.env.XAI_API_KEY).toBeUndefined();
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.XAI_API_KEY;
    }
  });
});
