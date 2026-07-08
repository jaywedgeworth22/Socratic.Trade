import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseBearSurvivors } from "../src/lib/strategy";

// Inline-Bear parse recovery — the strategy.ts sibling of PR #1091's debateProposal fix.
// A bare-array reply (DeepSeek v4 json_object drift) must be recovered, and NO malformed
// reply may read as a deliberate full veto (the old `parsed.proposals ?? []` silently
// vetoed everything when the proposals key was absent).
beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `bear-parse-${randomUUID()}.db`)}`;
});

const proposal = { symbol: "AAPL", side: "sell", type: "limit", quantity: 1, rationale: "trim" };

describe("parseBearSurvivors", () => {
  it("schema shape: object with proposals array → survivors, no fallback", () => {
    const out = parseBearSurvivors(JSON.stringify({ proposals: [proposal] }));
    expect(out.fallbackToBull).toBe(false);
    expect(out.proposals).toHaveLength(1);
  });

  it("object with EMPTY proposals array = a real deliberate full veto (no fallback)", () => {
    const out = parseBearSurvivors(JSON.stringify({ proposals: [] }));
    expect(out).toEqual({ proposals: [], fallbackToBull: false });
  });

  it("recovers a bare ARRAY of proposals (DeepSeek json_object drift, PR #1091 pattern)", () => {
    const out = parseBearSurvivors(JSON.stringify([proposal]));
    expect(out.fallbackToBull).toBe(false);
    expect(out.proposals).toHaveLength(1);
    expect((out.proposals[0] as { symbol?: string }).symbol).toBe("AAPL");
  });

  it("bare array of garbage → fallbackToBull, not a silent veto", () => {
    const out = parseBearSurvivors(JSON.stringify([123, "not a proposal", { foo: "bar" }]));
    expect(out.fallbackToBull).toBe(true);
  });

  it("bare EMPTY array → fallbackToBull (ambiguous ≠ deliberate veto; matches #1091 fail-closed)", () => {
    expect(parseBearSurvivors("[]").fallbackToBull).toBe(true);
  });

  it("object MISSING the proposals key → fallbackToBull (was the SILENT full-veto bug)", () => {
    const out = parseBearSurvivors(JSON.stringify({ verdict: "looks fine" }));
    expect(out.fallbackToBull).toBe(true);
  });

  it("non-object JSON and unparseable text → fallbackToBull", () => {
    expect(parseBearSurvivors("42").fallbackToBull).toBe(true);
    expect(parseBearSurvivors("not json at all").fallbackToBull).toBe(true);
  });
});
