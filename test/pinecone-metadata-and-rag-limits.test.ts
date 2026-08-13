import { describe, expect, it } from "vitest";
import {
  PINECONE_METADATA_HARD_LIMIT_BYTES,
  PINECONE_METADATA_SOFT_LIMIT_BYTES,
  enforcePineconeMetadataLimit,
  ragLimitStatus
} from "../src/lib/vector-db";

describe("enforcePineconeMetadataLimit", () => {
  it("leaves small metadata unchanged", () => {
    const meta = {
      text: "AAPL 8-K excerpt",
      symbol: "AAPL",
      source: "sec-8k",
      timestamp: "2026-08-13"
    };
    expect(enforcePineconeMetadataLimit(meta)).toEqual(meta);
  });

  it("truncates text so a 40962-byte payload stays under Pinecone's 40960 cap", () => {
    const prefix = {
      symbol: "AAPL",
      source: "sec-10k",
      timestamp: "2026-08-13T00:00:00.000Z",
      userId: "local",
      scope: "shared",
      tenant_scope: "shared:operator",
      provider_authority: "a".repeat(64),
      embed_model: "baai/bge-m3",
      embed_rev: 2,
      ingest_state: "committed",
      receipt_required: false
    };
    const overhead = Buffer.byteLength(JSON.stringify({ ...prefix, text: "" }), "utf8");
    const text = "x".repeat(PINECONE_METADATA_HARD_LIMIT_BYTES - overhead + 8);
    const capped = enforcePineconeMetadataLimit({ ...prefix, text });
    const bytes = Buffer.byteLength(JSON.stringify(capped), "utf8");
    expect(bytes).toBeLessThanOrEqual(PINECONE_METADATA_SOFT_LIMIT_BYTES);
    expect(bytes).toBeLessThanOrEqual(PINECONE_METADATA_HARD_LIMIT_BYTES);
    expect(String(capped.text).length).toBeLessThan(text.length);
    expect(capped.symbol).toBe("AAPL");
    expect(capped.source).toBe("sec-10k");
  });
});

describe("ragLimitStatus", () => {
  it("treats OpenRouter engine-overloaded 429s as transient, not a usage limit", () => {
    const message =
      'embed documents: Embedding API failed (isOpenRouter=true): 429 {"error":{"message":"HTTP 429: {\\"error\\":{\\"message\\":\\"The engine is currently overloaded. Please try again later.\\"}}"}}';
    expect(ragLimitStatus(message)).toBe("transient");
  });

  it("still classifies a plain 429 as rate_limited", () => {
    expect(ragLimitStatus("PineconeError: HTTP 429 Too Many Requests")).toBe("rate_limited");
  });
});
