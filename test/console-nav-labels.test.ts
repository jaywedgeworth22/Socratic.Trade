import { describe, expect, it } from "vitest";
import { DESTINATIONS, destinationLabel } from "../app/console/components/nav";
import { DEFAULT_MOBILE_TAB_HREFS } from "../app/console/lib/mobile-tabs";

/** Wave B / PR-B1: plain rail labels; desc keeps the Socratic metaphor. */
const PLAIN_LABELS: Record<string, string> = {
  "/console": "Home",
  "/console/scan": "Scan",
  "/console/activity": "Activity",
  "/console/results": "Results",
  "/console/macro": "Macro"
};

describe("console destination labels (Wave B / PR-B1)", () => {
  it("uses plain labels for Home / Scan / Activity / Results / Macro", () => {
    for (const [href, label] of Object.entries(PLAIN_LABELS)) {
      expect(destinationLabel(href)).toBe(label);
      const dest = DESTINATIONS.find((d) => d.href === href);
      expect(dest?.label).toBe(label);
    }
  });

  it("keeps metaphor language in descriptions, not labels", () => {
    const home = DESTINATIONS.find((d) => d.href === "/console");
    const activity = DESTINATIONS.find((d) => d.href === "/console/activity");
    const scan = DESTINATIONS.find((d) => d.href === "/console/scan");
    const results = DESTINATIONS.find((d) => d.href === "/console/results");
    const macro = DESTINATIONS.find((d) => d.href === "/console/macro");
    expect(home?.desc.toLowerCase()).toMatch(/thesis/);
    expect(activity?.desc.toLowerCase()).toMatch(/journal/);
    expect(scan?.desc.toLowerCase()).toMatch(/scan/);
    expect(results?.desc.toLowerCase()).toMatch(/performance|evidence/);
    expect(macro?.desc.toLowerCase()).toMatch(/regime|macro/);
    // Labels must not be the old metaphor nouns.
    for (const href of Object.keys(PLAIN_LABELS)) {
      const label = destinationLabel(href);
      expect(["Thesis", "Evidence", "Journal", "Outcomes", "Regime"]).not.toContain(label);
    }
  });

  it("pins mobile default tabs by href (rename-safe)", () => {
    expect(DEFAULT_MOBILE_TAB_HREFS).toEqual([
      "/console",
      "/console/approvals",
      "/console/activity",
      "/console/orders"
    ]);
  });
});
