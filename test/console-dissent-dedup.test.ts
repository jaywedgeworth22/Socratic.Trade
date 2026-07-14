import { describe, expect, it } from "vitest";
import { dissentItemsForDisplay } from "../app/console/lib/dissent";
import type { SocraticDecisionCase, SocraticEvidenceItem } from "../src/lib/types";

const REASON = "approve-at-half: Strong fundamentals, but execution risk warrants half size.";

function item(kind: SocraticEvidenceItem["kind"], title: string, summary: string): SocraticEvidenceItem {
  return { kind, title, summary, tone: "warning" };
}

function decision(dissent: SocraticEvidenceItem[], reason: string | null = REASON) {
  return {
    dissent,
    ...(reason
      ? {
          redTeamVerdict: {
            rejected: false,
            available: true,
            reason,
            model: "gpt-5.6-terra",
            trigger: "all_openings" as const
          }
        }
      : {})
  } satisfies Pick<SocraticDecisionCase, "dissent" | "redTeamVerdict">;
}

describe("dissentItemsForDisplay", () => {
  it("renders the Red Team reasoning once and keeps a distinct policy objection", () => {
    const distinct = item("policy", "Policy counterargument", "Sector exposure would exceed 35% of NAV.");
    const visible = dissentItemsForDisplay(
      decision([
        item("red_team", "Red Team objection", REASON),
        item("policy", "Policy counterargument", `Red Team approve-at-half haircut applied: ${REASON}`),
        distinct
      ])
    );

    expect(visible).toEqual([distinct]);
  });

  it("also removes generated failure and veto wrappers around the shown verdict reason", () => {
    expect(
      dissentItemsForDisplay(
        decision([
          item("policy", "Policy counterargument", `Red Team review unavailable (provider error): ${REASON}`),
          item("policy", "Policy counterargument", `red_team_veto: ${REASON}`)
        ])
      )
    ).toEqual([]);
  });

  it("preserves Red Team rows that add meaningful override context", () => {
    const overridden = item(
      "red_team",
      "Red Team rejection (overridden)",
      `${REASON} — overridden by a logged autonomy thesis; trade allowed to proceed.`
    );

    expect(dissentItemsForDisplay(decision([overridden]))).toEqual([overridden]);
  });

  it("keeps the first generic dissent item when no structured verdict owns it", () => {
    const first = item("red_team", "Red Team objection", REASON);
    const duplicate = item("policy", "Policy counterargument", REASON);

    expect(dissentItemsForDisplay(decision([first, duplicate], null))).toEqual([first]);
  });
});
