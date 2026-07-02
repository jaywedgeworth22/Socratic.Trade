import { describe, expect, it } from "vitest";
import {
  buildPatch,
  classify,
  classifyExtraPatch,
  clearedFallback,
  computeDiff,
  type FieldDef
} from "../app/console/lib/policy-diff";
import { ALL_DEFS, PANIC_BRAKE, STOPS_PLUMBING } from "../app/console/guardrails/field-defs";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { TradingPolicy } from "../src/lib/types";

const defByPath = (path: string): FieldDef => {
  const def = ALL_DEFS.find((d) => d.path === path);
  if (!def) throw new Error(`No guardrails FieldDef for ${path}`);
  return def;
};

const policy: TradingPolicy = {
  ...DEFAULT_POLICY,
  includedIndices: ["sp500"],
  additionalSymbols: ["AAPL"],
  blocklist: ["GME", "AMC"],
  permittedOrderTypes: ["market", "limit"],
  sellToFundBuy: "off"
};

describe("console guardrails: protective-toggle loosening direction (Codex findings 3 & 4)", () => {
  it("declares DISABLING the volatility panic brake as the loosening", () => {
    const def = PANIC_BRAKE.find((d) => d.path === "volPanicBrakeEnabled")!;
    expect(def.looserWhen).toBe("off");
    expect(classify(def, true, false)).toBe("looser");
    expect(classify(def, false, true)).toBe("tighter");
  });

  it("declares DISABLING broker-held brackets as the loosening", () => {
    const def = STOPS_PLUMBING.find((d) => d.path === "brokerBracketsEnabled")!;
    expect(def.looserWhen).toBe("off");
    expect(classify(def, true, false)).toBe("looser");
    expect(classify(def, false, true)).toBe("tighter");
  });

  it("keeps enabling-is-looser semantics for genuinely risk-increasing toggles", () => {
    expect(classify(defByPath("shortSellingEnabled"), false, true)).toBe("looser");
    expect(classify(defByPath("permitExtendedHours"), false, true)).toBe("looser");
    expect(classify(defByPath("shortSellingEnabled"), true, false)).toBe("tighter");
  });
});

describe("console guardrails: extraPatch loosening classification (Codex finding 2)", () => {
  it("classifies universe broadening as looser and narrowing as tighter", () => {
    const [broadened] = classifyExtraPatch(policy, { includedIndices: ["sp500", "russell2000"] });
    expect(broadened.direction).toBe("looser");
    expect(broadened.summary).toContain("russell2000");

    const [narrowed] = classifyExtraPatch(policy, { includedIndices: [] });
    expect(narrowed.direction).toBe("tighter");
  });

  it("classifies added always-include symbols as looser", () => {
    const [entry] = classifyExtraPatch(policy, { additionalSymbols: ["AAPL", "TSLA"] });
    expect(entry.direction).toBe("looser");
    expect(entry.summary).toContain("TSLA");
  });

  it("classifies REMOVING blocklist entries as looser and adding as tighter", () => {
    const [loosened] = classifyExtraPatch(policy, { blocklist: ["GME"] });
    expect(loosened.direction).toBe("looser");
    expect(loosened.summary).toContain("AMC");

    const [tightened] = classifyExtraPatch(policy, { blocklist: ["GME", "AMC", "BBBY"] });
    expect(tightened.direction).toBe("tighter");
  });

  it("classifies enabling more order types as looser", () => {
    const [entry] = classifyExtraPatch(policy, { permittedOrderTypes: ["market", "limit", "stop_market"] });
    expect(entry.direction).toBe("looser");
    const [removed] = classifyExtraPatch(policy, { permittedOrderTypes: ["limit"] });
    expect(removed.direction).toBe("tighter");
  });

  it("classifies escalating sell-to-fund-buy as looser and de-escalating as tighter", () => {
    const [escalated] = classifyExtraPatch(policy, { sellToFundBuy: "automated" });
    expect(escalated.direction).toBe("looser");
    const [deescalated] = classifyExtraPatch({ ...policy, sellToFundBuy: "automated" }, { sellToFundBuy: "off" });
    expect(deescalated.direction).toBe("tighter");
  });

  it("returns nothing for an absent extraPatch", () => {
    expect(classifyExtraPatch(policy, undefined)).toEqual([]);
  });
});

describe("console guardrails: cleared-field honesty (Codex finding 9)", () => {
  it("knows which cleared fields revert to a shipped default vs turn off", () => {
    // stopLossPct has a DEFAULT_POLICY value — clearing reverts to it (guard stays ON).
    expect(clearedFallback(defByPath("riskRules.stopLossPct"))).toBe(DEFAULT_POLICY.riskRules.stopLossPct);
    // maxOrderNotional ships without a default — clearing genuinely turns the cap off.
    expect(clearedFallback(defByPath("maxOrderNotional"))).toBeUndefined();
    // universeFloor keys live in a whole-stored object that overrides the default —
    // clearing one truly turns that floor off.
    expect(clearedFallback(defByPath("universeFloor.minPrice"))).toBeUndefined();
  });

  it("classifies clearing against the effective post-clear value, not blindly as 'looser'", () => {
    const stopLoss = defByPath("riskRules.stopLossPct");
    const shippedDefault = DEFAULT_POLICY.riskRules.stopLossPct!; // 8
    // 20% -> cleared: reverts to the 8% default, i.e. a TIGHTER stop.
    expect(classify(stopLoss, shippedDefault + 12, null)).toBe("tighter");
    // 5% -> cleared: reverts to 8%, i.e. LOOSER protection.
    expect(classify(stopLoss, shippedDefault - 3, null)).toBe("looser");
    // Clearing a no-default cap removes it entirely — the loosest move.
    expect(classify(defByPath("maxOrderNotional"), 100, null)).toBe("looser");
    // Clearing a no-default FLOOR also removes a guard — looser, not tighter.
    expect(classify(defByPath("universeFloor.minPrice"), 5, null)).toBe("looser");
    // Introducing a guard where none existed is tightening.
    expect(classify(defByPath("maxOrderNotional"), undefined, 250)).toBe("tighter");
  });

  it("seeds whole-replaced nested parents in the PUT body so sibling floors survive", () => {
    const def = defByPath("universeFloor.minPrice");
    const diff = computeDiff(policy, { "universeFloor.minPrice": null }, [def]);
    expect(diff).toHaveLength(1);
    const patch = buildPatch(diff, policy) as { universeFloor: Record<string, unknown> };
    // The cleared key is null (stripNullsDeep => absent server-side)...
    expect(patch.universeFloor.minPrice).toBeNull();
    // ...and the untouched sibling floors ride along, because /api/policy
    // replaces universeFloor wholesale rather than deep-merging it.
    expect(patch.universeFloor.minMarketCapUsd).toBe(policy.universeFloor?.minMarketCapUsd);
    expect(patch.universeFloor.minDollarVolume).toBe(policy.universeFloor?.minDollarVolume);
  });
});

describe("console guardrails: washSaleHandling select classification", () => {
  const def = defByPath("taxSettings.washSaleHandling");

  it("is a select field with the three modes ranked block < ask < auto", () => {
    expect(def.kind).toBe("select");
    expect(def.options?.map((o) => o.value)).toEqual(["block", "ask", "auto"]);
    expect(def.looseRank).toEqual({ block: 0, ask: 1, auto: 2 });
  });

  it("classifies block->ask and block->auto as LOOSER (typed word on LIVE)", () => {
    expect(classify(def, "block", "ask")).toBe("looser");
    expect(classify(def, "block", "auto")).toBe("looser");
    expect(classify(def, "ask", "auto")).toBe("looser");
  });

  it("classifies tightening back toward block as TIGHTER (one click, no typed word)", () => {
    expect(classify(def, "auto", "ask")).toBe("tighter");
    expect(classify(def, "ask", "block")).toBe("tighter");
    expect(classify(def, "auto", "block")).toBe("tighter");
  });

  it("treats a blank stored value as the shipped default ('block')", () => {
    // Legacy policies without the field: blank -> "ask" must still cost the typed word.
    expect(classify(def, undefined, "ask")).toBe("looser");
    expect(classify(def, "ask", undefined)).toBe("tighter");
    expect(classify(def, undefined, "block")).toBe("changed");
  });
});
