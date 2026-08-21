import { describe, expect, it } from "vitest";
import { nextTabId } from "../app/console/lib/tabs";

const IDS = ["all", "runs", "fills", "alerts", "audit"] as const;

describe("console tablist keyboard movement", () => {
  it("moves and wraps in both directions", () => {
    expect(nextTabId(IDS, "all", "ArrowRight")).toBe("runs");
    expect(nextTabId(IDS, "audit", "ArrowRight")).toBe("all");
    expect(nextTabId(IDS, "runs", "ArrowLeft")).toBe("all");
    expect(nextTabId(IDS, "all", "ArrowLeft")).toBe("audit");
  });

  it("jumps to the ends with Home/End", () => {
    expect(nextTabId(IDS, "fills", "Home")).toBe("all");
    expect(nextTabId(IDS, "runs", "End")).toBe("audit");
  });

  it("returns null for keys the tabs pattern does not own", () => {
    // The caller keys preventDefault off this: swallowing Tab/Enter/typing would
    // trap keyboard users inside the switcher.
    for (const key of ["Tab", "Enter", " ", "a", "ArrowDown", "Escape"]) {
      expect(nextTabId(IDS, "all", key)).toBeNull();
    }
  });

  it("leaves focus alone when the current tab is not in the list", () => {
    expect(nextTabId(IDS, "nope" as (typeof IDS)[number], "ArrowRight")).toBeNull();
    expect(nextTabId([] as readonly string[], "all", "ArrowRight")).toBeNull();
  });
});
