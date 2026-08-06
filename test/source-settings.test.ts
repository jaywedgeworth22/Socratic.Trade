import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getUserSourceSettingsMap,
  patchUserSourceSettings,
  resolveSourceBool,
  resolveSourceNumber
} from "../src/lib/source-settings";
import { SOURCE_SETTINGS_CATALOG } from "../src/lib/source-settings-catalog";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-source-settings-${randomUUID()}.db`)}`;
});

describe("source-settings", () => {
  beforeEach(() => {
    delete process.env.WEB_SOURCE_SEC8K_FULL_BODY;
    delete process.env.SEC_FILING_RAG_MAX_PER_RUN;
    patchUserSourceSettings("local", {
      WEB_SOURCE_SEC8K_FULL_BODY: null,
      SEC_FILING_RAG_MAX_PER_RUN: null
    });
  });

  it("catalog has FMP module flags and SEC knobs", () => {
    const ids = SOURCE_SETTINGS_CATALOG.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "fmpRealTimeDataEnabled",
        "fmpFundamentalsDataEnabled",
        "WEB_SOURCE_SEC8K_FULL_BODY",
        "SEC_FILING_RAG_MAX_PER_RUN",
        "RAG_EMBED_DISCLOSURES"
      ])
    );
  });

  it("user override beats env for booleans", () => {
    process.env.WEB_SOURCE_SEC8K_FULL_BODY = "on";
    expect(resolveSourceBool("WEB_SOURCE_SEC8K_FULL_BODY")).toBe(true);
    patchUserSourceSettings("local", { WEB_SOURCE_SEC8K_FULL_BODY: false });
    expect(resolveSourceBool("WEB_SOURCE_SEC8K_FULL_BODY")).toBe(false);
    expect(getUserSourceSettingsMap("local").WEB_SOURCE_SEC8K_FULL_BODY).toBe(false);
  });

  it("user override beats env for numbers", () => {
    process.env.SEC_FILING_RAG_MAX_PER_RUN = "10";
    expect(resolveSourceNumber("SEC_FILING_RAG_MAX_PER_RUN")).toBe(10);
    patchUserSourceSettings("local", { SEC_FILING_RAG_MAX_PER_RUN: 42 });
    expect(resolveSourceNumber("SEC_FILING_RAG_MAX_PER_RUN")).toBe(42);
  });

  it("reset null falls back to env/default", () => {
    patchUserSourceSettings("local", { WEB_SOURCE_SEC8K_FULL_BODY: true });
    expect(resolveSourceBool("WEB_SOURCE_SEC8K_FULL_BODY")).toBe(true);
    patchUserSourceSettings("local", { WEB_SOURCE_SEC8K_FULL_BODY: null });
    expect(resolveSourceBool("WEB_SOURCE_SEC8K_FULL_BODY")).toBe(false);
  });
});
