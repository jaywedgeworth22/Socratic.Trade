// Deterministic market-regime flip detector (Phase 1 — no LLM, no cost).
//
// The regime label (VIX + yield-curve) is otherwise recomputed every run and persisted nowhere,
// so there's no way to notice a *change*. This stores the current label in the no-audit internal
// KV and, on a flip, records an audit, pushes a dashboard refresh, and broadcasts a material event
// (which only triggers a run when TRIGGER_ENGINE is on — otherwise a free, observable signal).

import { audit, getInternalSetting, setInternalSetting } from "./db";
import { determineMarketRegime, fetchMacroDataWithLiveVix, type MacroData } from "./macro";
import { classifyMarketRegime, isEscalationMarketRegime, regimeFromLabel } from "./market-regime";
import { deriveMacroMetrics } from "./macro-metrics";
import { computeMultiSignalSeverity } from "./regime-severity";
import { emitDashboardEvent } from "./events";
import { broadcastMaterialEvent } from "./triggers";

// Macro-only severity (no signals fetch here — checkRegimeFlip only has `macro` in scope).
// Best-effort: a scorer failure must never affect flip detection/notification. Logged as
// `severityMacroOnly` in the regime_flip audit payload to distinguish it from the fuller
// (macro + signals) `regimeSeverity` computed at strategy-run time (strategy.ts).
function macroOnlySeverity(macro: MacroData): number | undefined {
  try {
    const derived = deriveMacroMetrics(macro);
    const hyCreditSpreadPct = macro.hyCreditSpread ? parseFloat(macro.hyCreditSpread) : undefined;
    const result = computeMultiSignalSeverity({
      regime: classifyMarketRegime(macro).regime,
      vix: macro.vix ? parseFloat(macro.vix) : undefined,
      vixTermStructure: derived.vixTermStructure,
      hyCreditSpreadPct: Number.isFinite(hyCreditSpreadPct) ? hyCreditSpreadPct : undefined
    });
    return Number(result.severity.toFixed(2));
  } catch {
    return undefined;
  }
}

const REGIME_KEY = "regime:current";

/**
 * Regimes the expert panel flagged for escalation. Delegates to the shared typed source of truth
 * (`isEscalationMarketRegime` ∘ `regimeFromLabel`) so this consumer, the crisis cap (policy.ts),
 * and the bear filter (strategy.ts) can never silently desync on a regime relabel — the
 * string-coupling the typed `MarketRegime` enum was introduced to kill.
 *
 * Imported from ./market-regime (a dependency-free module), NOT ./macro: test/regime-watch.test.ts
 * mocks the ENTIRE `./macro` module (`vi.doMock("../src/lib/macro", ...)`), so importing the typed
 * helpers from ./macro would return `undefined` under that mock. ./market-regime is unmocked, so the
 * real classifier runs. Behavior is unchanged on every canonical persisted label (crisis / risk-off /
 * cautious-inverted → escalation; neutral / risk-on → not) AND on the test's non-canonical
 * "Neutral (Moderate)" (→ unknown → not); a non-canonical free-text label now reads non-escalating
 * rather than accidentally matching a substring.
 */
export function isEscalationRegime(label: string): boolean {
  return isEscalationMarketRegime(regimeFromLabel(label));
}

/**
 * Compute the current regime, compare to the stored label, and on a change persist + announce it.
 * Cheap (one cached macro read + one short-TTL live VIX read); safe to call on every scheduler
 * tick. Seeds silently on first run. Uses the LIVE VIX overlay (fetchMacroDataWithLiveVix), not
 * the bare 24h-cached fetchMacroData snapshot — flip detection off a day-old VIX could miss an
 * intraday regime change (and the panic brake above it) for up to a day.
 */
export async function checkRegimeFlip(userId: string = "local"): Promise<void> {
  const macro = await fetchMacroDataWithLiveVix(userId);
  const next = determineMarketRegime(macro);
  const prev = getInternalSetting<string>(REGIME_KEY);

  if (!prev) {
    setInternalSetting(REGIME_KEY, next); // seed; don't announce a "flip" from nothing
    return;
  }
  if (prev === next) return;

  setInternalSetting(REGIME_KEY, next);
  audit(
    "regime_flip",
    { from: prev, to: next, vix: macro.vix, vixAsOf: macro.vixAsOf, fedFunds: macro.fedFundsRate, dgs10: macro.dgs10Treasury, escalation: isEscalationRegime(next), severityMacroOnly: macroOnlySeverity(macro) },
    userId
  );
  // Immediate dashboard refresh even when the trigger engine is off.
  emitDashboardEvent({ type: "dirty", at: new Date().toISOString(), detail: { regimeFrom: prev, regimeTo: next } });
  // Material event: only broadcast when flipping INTO an escalation regime (Risk-Off / Crisis /
  // Inverted-curve). A de-escalation back to calm should not trigger an expensive LLM run.
  if (isEscalationRegime(next)) {
    broadcastMaterialEvent({ type: "regime", sourceId: `${prev}->${next}`, reason: `Regime flip ${prev} → ${next}` });
  }
}
