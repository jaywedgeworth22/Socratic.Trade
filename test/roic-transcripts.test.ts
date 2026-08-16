import { describe, expect, it } from "vitest";
import {
  parseRoicEarningsCallList,
  parseRoicTranscriptResponse,
  publishedAtIso,
  recentFiscalPeriods,
  roleOfSpeaker,
  roicRefreshDueFromState,
  roicTranscriptAccession,
  roicV3Identifiers,
  speakerTurnsFromRoicPayload,
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

  it("roicTranscriptQuartersForPlan maps vendor depths (2 / 20 / all-capped)", () => {
    // https://www.roic.ai/pricing — Free 2 quarters, Individual 20, Professional all (app cap 40).
    expect(roicTranscriptQuartersForPlan("free")).toBe(2);
    expect(roicTranscriptQuartersForPlan("individual")).toBe(20);
    expect(roicTranscriptQuartersForPlan("professional")).toBe(40);
    expect(roicTranscriptQuartersForPlan("enterprise")).toBe(40);
  });

  it("env override can request the Individual 20-quarter depth (no hidden 8-cap)", async () => {
    const prev = process.env.ROIC_TRANSCRIPTS_QUARTERS_PER_SYMBOL;
    process.env.ROIC_TRANSCRIPTS_QUARTERS_PER_SYMBOL = "20";
    const { quartersPerSymbol } = await import("../src/lib/web-sources/roic-transcripts");
    expect(quartersPerSymbol()).toBe(20);
    if (prev === undefined) delete process.env.ROIC_TRANSCRIPTS_QUARTERS_PER_SYMBOL;
    else process.env.ROIC_TRANSCRIPTS_QUARTERS_PER_SYMBOL = prev;
  });

  it("parses the v3 list payload and ignores malformed rows", () => {
    const rows = parseRoicEarningsCallList(
      {
        data: [
          { id: "ecall_1", symbol: "NASDAQ:AAPL", fiscal_year: 2026, fiscal_quarter: 2, date: "2026-05-01" },
          { id: "bad", symbol: "MSFT" },
          { fiscal_year: 2025, fiscal_quarter: 4, symbol: "IBM" }
        ]
      },
      "AAPL"
    );
    expect(rows).toEqual([
      { id: "ecall_1", symbol: "AAPL", year: 2026, quarter: 2, date: "2026-05-01" },
      { id: undefined, symbol: "IBM", year: 2025, quarter: 4, date: undefined }
    ]);
  });

  it("maps speaker labels to stable RAG section roles", () => {
    expect(roleOfSpeaker("Operator")).toBe("operator");
    expect(roleOfSpeaker("Tim Cook, CEO")).toBe("management");
    expect(roleOfSpeaker("Jane Doe, Analyst, Goldman Sachs")).toBe("analyst");
    expect(roleOfSpeaker("Unknown")).toBe("qa");
    expect(speakerTurnsFromRoicPayload([{ speaker: "CEO", text: "Hello" }])).toEqual([
      { speaker: "CEO", text: "Hello" }
    ]);
  });

  it("publishedAtIso prefers a real call date and never emits 2025-Q2", () => {
    expect(publishedAtIso("2026-05-01", 2026, 2)).toBe(new Date("2026-05-01").toISOString());
    const fallback = publishedAtIso(undefined, 2025, 2);
    expect(Number.isFinite(Date.parse(fallback))).toBe(true);
    expect(fallback.startsWith("2025-06-28")).toBe(true);
  });

  it("builds a stable accession for skip-if-stored", () => {
    expect(roicTranscriptAccession("aapl", 2026, 2)).toBe("roic:AAPL:2026Q2");
  });

  it("roicRefreshDueFromState resumes a leftover cursor and does not restack an in-flight walk", () => {
    const hour = 3_600_000;
    const now = Date.parse("2026-08-16T20:00:00.000Z");
    const base = {
      enabled: true,
      lastCompleteAt: null,
      lastAttemptAt: null,
      now,
      completeTtlMs: 6 * hour,
      runStaleMs: 30 * 60 * 1_000
    };
    expect(roicRefreshDueFromState({ ...base, cursorQueueLength: 0 })).toBe(true);
    expect(roicRefreshDueFromState({ ...base, enabled: false, cursorQueueLength: 4 })).toBe(false);
    expect(roicRefreshDueFromState({ ...base, cursorQueueLength: 12 })).toBe(true);
    expect(
      roicRefreshDueFromState({
        ...base,
        cursorQueueLength: 0,
        lastCompleteAt: "2026-08-16T18:00:00.000Z"
      })
    ).toBe(false);
    expect(
      roicRefreshDueFromState({
        ...base,
        cursorQueueLength: 0,
        lastAttemptAt: "2026-08-16T19:50:00.000Z"
      })
    ).toBe(false);
    expect(
      roicRefreshDueFromState({
        ...base,
        cursorQueueLength: 0,
        lastAttemptAt: "2026-08-16T19:00:00.000Z"
      })
    ).toBe(true);
    expect(
      roicRefreshDueFromState({
        ...base,
        cursorQueueLength: 3,
        lastAttemptAt: "2026-08-16T19:50:00.000Z"
      })
    ).toBe(true);
  });
});
