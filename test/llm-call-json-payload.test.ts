import { describe, expect, it } from "vitest";
import { extractJsonPayload } from "../src/lib/llm-call";

// Root-cause coverage for the gemini-3.5-flash silent-failure (single-adversary-consolidation §4.1/R9):
// a fenced or prose-wrapped LLM reply must still yield parseable JSON, and a broken reply must NOT
// be coerced into fabricated valid JSON — the caller's JSON.parse should still reject it.
describe("extractJsonPayload", () => {
  it("passes bare JSON through unchanged", () => {
    const s = '{"rejected":false,"reason":"ok"}';
    expect(extractJsonPayload(s)).toBe(s);
    expect(JSON.parse(extractJsonPayload(s))).toEqual({ rejected: false, reason: "ok" });
  });

  it("strips a ```json fenced block (the gemini failure mode)", () => {
    const wrapped = '```json\n{"verdict":"approve-at-half","reason":"sizing"}\n```';
    expect(JSON.parse(extractJsonPayload(wrapped))).toEqual({ verdict: "approve-at-half", reason: "sizing" });
  });

  it("strips a bare ``` fence with no language tag", () => {
    expect(JSON.parse(extractJsonPayload('```\n{"a":1}\n```'))).toEqual({ a: 1 });
  });

  it("extracts JSON embedded in prose", () => {
    const prose = 'Sure! Here is my verdict:\n{"verdict":"reject","reason":"overbought"}\nHope that helps.';
    expect(JSON.parse(extractJsonPayload(prose))).toEqual({ verdict: "reject", reason: "overbought" });
  });

  it("does not miscount braces inside string values", () => {
    const s = '{"reason":"breaks } below { support","rejected":true}';
    expect(JSON.parse(extractJsonPayload(s))).toEqual({ reason: "breaks } below { support", rejected: true });
  });

  it("handles nested objects and arrays", () => {
    const s = 'noise {"a":{"b":[1,2,{"c":3}]},"d":"}"} trailing';
    expect(JSON.parse(extractJsonPayload(s))).toEqual({ a: { b: [1, 2, { c: 3 }] }, d: "}" });
  });

  it("extracts an array root", () => {
    expect(JSON.parse(extractJsonPayload('```json\n[{"x":1},{"y":2}]\n```'))).toEqual([{ x: 1 }, { y: 2 }]);
  });

  it("is not greedy across multiple JSON-looking blocks (R9)", () => {
    // Greedy first-to-last slicing would grab '{"a":1} ... {"b":2}' and fail to parse.
    const s = '{"a":1} and separately {"b":2}';
    expect(JSON.parse(extractJsonPayload(s))).toEqual({ a: 1 });
  });

  it("returns non-JSON text unchanged so the caller's JSON.parse fails loudly (never fabricates)", () => {
    const refusal = "I can't help with that request.";
    expect(extractJsonPayload(refusal)).toBe(refusal);
    expect(() => JSON.parse(extractJsonPayload(refusal))).toThrow();
  });

  it("does not fabricate valid JSON from a truncated/unbalanced object", () => {
    const truncated = '{"verdict":"approve","reason":"cut off here';
    expect(() => JSON.parse(extractJsonPayload(truncated))).toThrow();
  });
});
