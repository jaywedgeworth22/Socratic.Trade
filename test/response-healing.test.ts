import { describe, it, expect } from "vitest";
import { healMalformedJson } from "../src/lib/response-healing";

describe("healMalformedJson (local)", () => {
  it("heals a truncated JSON array", () => {
    const brokenJson = `{"proposals": [{"symbol": "AAPL", "side": "buy"`;
    const result = healMalformedJson<{ proposals: any[] }>(brokenJson);
    expect(result).toBeDefined();
  });

  it("extracts and heals JSON from within conversational text", () => {
    const brokenJson = `Here are my proposals:\n\n\`\`\`json\n{"proposals": [{"symbol": "TSLA", "side": "sell"`;
    const result = healMalformedJson<{ proposals: any[] }>(brokenJson);
    expect(result).toBeDefined();
  });

  it("returns undefined for completely unrecoverable gibberish", () => {
    const brokenJson = `I am an AI and I cannot answer this request.`;
    const result = healMalformedJson<unknown>(brokenJson);
    expect(result).toBeUndefined();
  });
});
