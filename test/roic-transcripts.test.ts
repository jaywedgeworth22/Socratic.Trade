import { describe, expect, it } from "vitest";
import { parseRoicTranscriptResponse } from "../src/lib/web-sources/roic-transcripts";

describe("roic-transcripts", () => {
  it("parses valid transcript JSON response", () => {
    const raw = {
      symbol: "AAPL",
      year: 2024,
      quarter: 1,
      date: "2024-02-01",
      transcript: "This is a full transcript text for Apple Inc. Q1 2024 earnings call. ".repeat(10)
    };

    const parsed = parseRoicTranscriptResponse(raw, "AAPL", 2024, 1);
    expect(parsed).not.toBeNull();
    expect(parsed?.symbol).toBe("AAPL");
    expect(parsed?.year).toBe(2024);
    expect(parsed?.quarter).toBe(1);
    expect(parsed?.date).toBe("2024-02-01");
    expect(parsed?.content.length).toBeGreaterThan(200);
  });

  it("returns null for short preview or missing content", () => {
    const short = {
      symbol: "AAPL",
      transcript: "Too short"
    };

    const parsed = parseRoicTranscriptResponse(short, "AAPL", 2024, 1);
    expect(parsed).toBeNull();
  });
});
