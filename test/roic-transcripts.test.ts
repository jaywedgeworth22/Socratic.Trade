import { describe, expect, it } from "vitest";
import {
  parseRoicTranscriptResponse,
  recentFiscalPeriods,
  roicV3Identifiers,
  transcriptTextFromRoicPayload
} from "../src/lib/web-sources/roic-transcripts";
import { roicTranscriptQuartersForPlan } from "../src/lib/provider-tier-plan";

describe("roic-transcripts", () => {
  it("parses valid transcript JSON response with content string", () => {
    const raw = {
      symbol: "AAPL",
      year: 2024,
      quarter: 1,
      date: "2024-02-01",
      content: "This is a full transcript text for Apple Inc. Q1 2024 earnings call. ".repeat(10)
    };

    const parsed = parseRoicTranscriptResponse(raw, "AAPL", 2024, 1);
    expect(parsed).not.toBeNull();
    expect(parsed?.symbol).toBe("AAPL");
    expect(parsed?.year).toBe(2024);
    expect(parsed?.quarter).toBe(1);
    expect(parsed?.date).toBe("2024-02-01");
    expect(parsed?.content.length).toBeGreaterThan(200);
  });

  it("parses v3 speaker-turn transcript arrays", () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({
      speaker: i % 2 === 0 ? "CEO" : "Analyst",
      text: `This is turn ${i} with enough words about guidance margins and outlook for the year. `
    }));
    const raw = {
      symbol: "NASDAQ:AAPL",
      fiscal_year: 2025,
      fiscal_quarter: 2,
      date: "2025-05-01",
      transcript: turns
    };
    const parsed = parseRoicTranscriptResponse(raw, "AAPL", 2025, 2);
    expect(parsed).not.toBeNull();
    expect(parsed?.year).toBe(2025);
    expect(parsed?.quarter).toBe(2);
    expect(parsed?.content).toContain("CEO:");
    expect(parsed!.content.length).toBeGreaterThan(200);
  });

  it("returns null for short preview or missing content", () => {
    const short = {
      symbol: "AAPL",
      transcript: "Too short"
    };

    const parsed = parseRoicTranscriptResponse(short, "AAPL", 2024, 1);
    expect(parsed).toBeNull();
    expect(transcriptTextFromRoicPayload("x")).toBeNull();
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

  it("roicV3Identifiers prefer exchange:ticker forms", () => {
    expect(roicV3Identifiers("AAPL")[0]).toBe("NASDAQ:AAPL");
    expect(roicV3Identifiers("NYSE:IBM")).toEqual(["NYSE:IBM"]);
  });

  it("roicTranscriptQuartersForPlan maps free vs individual", () => {
    expect(roicTranscriptQuartersForPlan("free")).toBe(2);
    expect(roicTranscriptQuartersForPlan("individual")).toBe(6);
    expect(roicTranscriptQuartersForPlan("professional")).toBe(8);
  });
});
