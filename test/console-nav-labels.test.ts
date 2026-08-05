import { describe, expect, it } from "vitest";
import { DESTINATIONS, destinationLabel } from "../app/console/components/nav";
import { DEFAULT_MOBILE_TAB_HREFS } from "../app/console/lib/mobile-tabs";

/**
 * PR-B1 (UX program Wave B): plain-language rail labels.
 * destinationLabel must match DESTINATIONS so page h1s cannot drift from the rail.
 */
describe("console nav plain labels (PR-B1)", () => {
  it("uses owner D2 plain labels for the five renamed destinations", () => {
    expect(destinationLabel("/console")).toBe("Home");
    expect(destinationLabel("/console/scan")).toBe("Scan");
    expect(destinationLabel("/console/activity")).toBe("Activity");
    expect(destinationLabel("/console/results")).toBe("Results");
    expect(destinationLabel("/console/macro")).toBe("Macro");
  });

  it("keeps dest descriptions (metaphor) non-empty for every destination", () => {
    for (const d of DESTINATIONS) {
      expect(d.desc.trim().length).toBeGreaterThan(10);
      expect(d.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("pins mobile tabs by href (renames do not break stored membership)", () => {
    expect(DEFAULT_MOBILE_TAB_HREFS).toEqual([
      "/console",
      "/console/approvals",
      "/console/activity",
      "/console/orders"
    ]);
    // Labels derive from DESTINATIONS via href — never stored as strings.
    const labels = DEFAULT_MOBILE_TAB_HREFS.map((href) => destinationLabel(href));
    expect(labels).toEqual(["Home", "Proposals", "Activity", "Orders"]);
  });

  it("destinationLabel falls back to the href when unknown", () => {
    expect(destinationLabel("/console/does-not-exist")).toBe("/console/does-not-exist");
  });
});
