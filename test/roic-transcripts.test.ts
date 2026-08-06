import { describe, expect, it } from "vitest";
import {
  parseRoicTranscriptResponse,
  recentFiscalPeriods
} from "../src/lib/web-sources/roic-transcripts";

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

  it("recentFiscalPeriods walks backward from last completed calendar quarter", () => {
    // 2026-08-05 → current Q3 incomplete → start at Q2 2026
    const periods = recentFiscalPeriods(new Date("2026-08-05T12:00:00Z"), 3);
    expect(periods).toEqual([
      { year: 2026, quarter: 2 },
      { year: 2026, quarter: 1 },
      { year: 2025, quarter: 4 }
    ]);
    // January → last completed is Q4 prior year
    const jan = recentFiscalPeriods(new Date("2026-01-15T00:00:00Z"), 1);
    expect(jan).toEqual([{ year: 2025, quarter: 4 }]);
  });
});
