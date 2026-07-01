import { describe, expect, it } from "vitest";
import { SETTINGS_FIELDS, searchSettings } from "../app/settings-search";

describe("settings search index (PR #3)", () => {
  // The index is DERIVED from SETTINGS_FIELDS: searchSettings iterates the same
  // catalog the UI renders from. This is the "add-a-field-and-it's-searchable"
  // guarantee — every field in the catalog is findable by its own label with no
  // second list to maintain. Add a field to SETTINGS_FIELDS and this passes for
  // it automatically; a parallel search list would make this fail.
  it("makes every catalog field findable by its own label (no parallel list)", () => {
    for (const field of SETTINGS_FIELDS) {
      const results = searchSettings(field.label);
      expect(results.map((f) => f.id)).toContain(field.id);
    }
  });

  it("finds a field by an old-name synonym (redirect for returning users)", () => {
    // "max position size" is the OLD phrasing; it must resolve to the order-cap field.
    const byOldName = searchSettings("max position size");
    expect(byOldName.map((f) => f.id)).toContain("guardrails.maxOrderSize");
    // "notifications" (retired noun) still finds the alert-delivery field.
    expect(searchSettings("notifications").map((f) => f.id)).toContain("settings.alertWebhook");
  });

  it("matches by label, section/destination, scope word, and backing field", () => {
    expect(searchSettings("guardrails").length).toBeGreaterThan(0);
    expect(searchSettings("account").length).toBeGreaterThan(0);
    expect(searchSettings("maxOrderNotional").map((f) => f.id)).toContain("guardrails.maxOrderSize");
  });

  it("ranks label-prefix hits ahead of synonym-only hits", () => {
    const results = searchSettings("stop-loss");
    expect(results[0]?.id).toBe("guardrails.stopLoss");
  });

  it("returns nothing for an empty query", () => {
    expect(searchSettings("")).toEqual([]);
    expect(searchSettings("   ")).toEqual([]);
  });
});
