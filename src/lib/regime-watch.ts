// Deterministic market-regime flip detector (Phase 1 — no LLM, no cost).
//
// The regime label (VIX + yield-curve) is otherwise recomputed every run and persisted nowhere,
// so there's no way to notice a *change*. This stores the current label in the no-audit internal
// KV and, on a flip, records an audit, pushes a dashboard refresh, and broadcasts a material event
// (which only triggers a run when TRIGGER_ENGINE is on — otherwise a free, observable signal).

import { audit, getInternalSetting, setInternalSetting } from "./db";
import { determineMarketRegime, fetchMacroDataWithLiveVix } from "./macro";
import { emitDashboardEvent } from "./events";
import { broadcastMaterialEvent } from "./triggers";

const REGIME_KEY = "regime:current";

/**
 * Regimes the expert panel flagged for escalation (kept here for downstream consumers).
 * Kept as a plain substring check (not `regimeFromLabel`/`isEscalationMarketRegime` from
 * ./macro) deliberately: test/regime-watch.test.ts mocks the ENTIRE `./macro` module
 * (`vi.doMock("../src/lib/macro", ...)`) supplying only `fetchMacroData`/`determineMarketRegime`
 * with test-local label strings ("Neutral (Moderate)", not the real "Neutral (Normal
 * Volatility)"), so importing the typed helpers here would break under that mock. The
 * canonical typed path is `isEscalationMarketRegime`/`regimeFromLabel` in ./macro — use those
 * from any NEW consumer that doesn't need to tolerate a fully-mocked macro module.
 */
export function isEscalationRegime(label: string): boolean {
  const l = label.toLowerCase();
  return l.includes("crisis") || l.includes("inverted") || l.includes("risk-off");
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
    { from: prev, to: next, vix: macro.vix, vixAsOf: macro.vixAsOf, fedFunds: macro.fedFundsRate, dgs10: macro.dgs10Treasury, escalation: isEscalationRegime(next) },
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
