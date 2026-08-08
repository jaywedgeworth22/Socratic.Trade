import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SocraticDecisionCase } from "../src/lib/types";
import DecisionsIndexPage from "../app/console/decisions/page";
import { DecisionsList } from "../app/console/decisions/decisions-list";

/** Smoke coverage for the /console/decisions index (#2556): the console Home
 *  "All Decisions" link 404'd because this route had no page. The default export
 *  must render (initial loading state — effects don't run under static render),
 *  and the pure list body must show symbol, side, thesis tag, status, and age,
 *  each row linking into /console/decisions/[id]. */

function decisionCase(overrides: Partial<SocraticDecisionCase> = {}): SocraticDecisionCase {
  return {
    id: "dec-1",
    userId: "local",
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    symbol: "NVDA",
    side: "buy",
    status: "placed",
    authority: "propose",
    thesis: "Momentum with improving breadth",
    rationale: "r",
    action: "BUY NVDA",
    thesisTag: "quality_momentum",
    evidence: [],
    ragAttributions: [],
    dissent: [],
    lessons: [],
    coachNotes: [],
    ...overrides
  };
}

describe("console decisions index (#2556)", () => {
  it("the route's default export renders (no more 404 target from Home's All Decisions link)", () => {
    const html = renderToStaticMarkup(<DecisionsIndexPage />);
    expect(html).toContain("Decisions");
    expect(html).toContain("Loading decisions");
  });

  it("lists symbol, side, thesis tag, status, and age, linking each row to its trace", () => {
    const html = renderToStaticMarkup(
      <DecisionsList decisions={[decisionCase(), decisionCase({ id: "dec 2", symbol: undefined, side: undefined, status: "rejected", thesisTag: undefined })]} />
    );
    expect(html).toContain("NVDA");
    expect(html).toContain("BUY");
    expect(html).toContain("Quality Momentum"); // thesisTagLabel de-underscores + title-cases
    expect(html).toContain("Momentum with improving breadth");
    expect(html).toContain('href="/console/decisions/dec-1"');
    // Ids are URL-encoded into the href — a raw space would break the deep link.
    expect(html).toContain('href="/console/decisions/dec%202"');
    // A portfolio-level case (no symbol) renders honestly, not as a blank row.
    expect(html).toContain("Portfolio");
    // Status labels come from the shared decisionStatusLabel vocabulary.
    expect(html.toLowerCase()).toContain("placed");
    expect(html.toLowerCase()).toContain("rejected");
    // Age renders as relative time with the exact timestamp on the title attribute.
    expect(html).toContain("ago");
  });

  it("shows an honest empty state when no decision traces exist", () => {
    const html = renderToStaticMarkup(<DecisionsList decisions={[]} />);
    expect(html).toContain("No decision traces yet.");
  });
});
