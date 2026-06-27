import { describe, expect, it } from "vitest";
import { buildTools, type ToolDeps } from "../src/lib/chat/tools";

// Read-only state tools: get_portfolio_pnl, get_performance_summary, get_reflection. They read app
// state via injected deps and degrade gracefully (null/empty) when a dep isn't wired — chat never
// invents numbers.
const tools = buildTools();
const ctx = (deps: Partial<ToolDeps>) => ({ userId: "u1", deps: deps as ToolDeps });

describe("read-only chat state tools", () => {
  it("get_portfolio_pnl returns the dep's P&L and degrades to null without the dep", async () => {
    const pnl = { liveRealizedPnl: 10, paperRealizedPnl: 5, liveUnrealizedPnl: 2, paperUnrealizedPnl: 1, liveWinRate: 0.6, paperWinRate: 0.5 };
    expect(await tools.get_portfolio_pnl.execute({}, ctx({ getPortfolioPnl: async () => pnl }))).toEqual({ pnl });
    expect(await tools.get_portfolio_pnl.execute({}, ctx({}))).toEqual({ pnl: null });
  });

  it("get_performance_summary returns thesis+regime scorecards and degrades to empty", async () => {
    const summary = { byThesis: [{ key: "breakout", trades: 3, winRate: 0.66, avgReturnPct: 2.1, totalPnl: 30 }], byRegime: [] };
    expect(await tools.get_performance_summary.execute({}, ctx({ getPerformanceSummary: () => summary }))).toEqual(summary);
    expect(await tools.get_performance_summary.execute({}, ctx({}))).toEqual({ byThesis: [], byRegime: [] });
  });

  it("get_reflection returns the reflection text, or null when empty/absent", async () => {
    expect(await tools.get_reflection.execute({}, ctx({ getReflection: () => "Cut losers faster." }))).toEqual({ reflection: "Cut losers faster." });
    expect(await tools.get_reflection.execute({}, ctx({ getReflection: () => "" }))).toEqual({ reflection: null });
    expect(await tools.get_reflection.execute({}, ctx({}))).toEqual({ reflection: null });
  });

  it("all three are flagged read-only (no execution/state mutation)", () => {
    expect(tools.get_portfolio_pnl.readOnly).toBe(true);
    expect(tools.get_performance_summary.readOnly).toBe(true);
    expect(tools.get_reflection.readOnly).toBe(true);
  });
});
