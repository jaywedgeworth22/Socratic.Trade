import { describe, expect, it } from "vitest";
import { summarizeMissedOpportunities, type MissedOpportunityInput } from "../src/lib/strategy-tuning";

describe("summarizeMissedOpportunities", () => {
  it("keeps only positive-return skipped names and shapes the items", () => {
    const rows: MissedOpportunityInput[] = [
      { symbol: "AAA", returnPct: 12.5, score: 88, sector: "Tech", regime: "expansion", dominantFactor: "momentum", ageDays: 6 },
      { symbol: "BBB", returnPct: -3.2, dominantFactor: "value" }, // negative — excluded
      { symbol: "CCC", returnPct: 0, dominantFactor: "value" }, // zero — excluded
      { symbol: "DDD", returnPct: 4.1, dominantFactor: "momentum" }
    ];
    const summary = summarizeMissedOpportunities(rows);
    expect(summary.count).toBe(2);
    expect(summary.items.map((i) => i.symbol)).toEqual(["AAA", "DDD"]);
    expect(summary.items[0]).toMatchObject({ symbol: "AAA", returnPct: 12.5, dominantFactor: "momentum", sector: "Tech" });
    // optional fields are omitted, not set to undefined
    expect(Object.prototype.hasOwnProperty.call(summary.items[1], "sector")).toBe(false);
  });

  it("flags a recurring dominant factor when it appears in >= 2 missed winners", () => {
    const rows: MissedOpportunityInput[] = [
      { symbol: "AAA", returnPct: 10, dominantFactor: "momentum" },
      { symbol: "BBB", returnPct: 8, dominantFactor: "momentum" },
      { symbol: "CCC", returnPct: 5, dominantFactor: "value" }
    ];
    const summary = summarizeMissedOpportunities(rows);
    expect(summary.recurringFactor).toBe("momentum");
    expect(summary.recurringFactorCount).toBe(2);
  });

  it("does not flag a recurring factor when none repeats", () => {
    const rows: MissedOpportunityInput[] = [
      { symbol: "AAA", returnPct: 10, dominantFactor: "momentum" },
      { symbol: "BBB", returnPct: 8, dominantFactor: "value" }
    ];
    const summary = summarizeMissedOpportunities(rows);
    expect(summary.recurringFactor).toBeUndefined();
    expect(summary.recurringFactorCount).toBeUndefined();
  });

  it("caps the item list at the limit but still counts every winner", () => {
    const rows: MissedOpportunityInput[] = Array.from({ length: 12 }, (_, i) => ({ symbol: `S${i}`, returnPct: 12 - i * 0.5 }));
    const summary = summarizeMissedOpportunities(rows, 8);
    expect(summary.items).toHaveLength(8);
    expect(summary.count).toBe(12);
  });

  it("returns an empty summary when there are no missed winners", () => {
    const summary = summarizeMissedOpportunities([{ symbol: "AAA", returnPct: -5 }]);
    expect(summary.count).toBe(0);
    expect(summary.items).toEqual([]);
    expect(summary.recurringFactor).toBeUndefined();
  });
});
