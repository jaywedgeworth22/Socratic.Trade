// tuning-invariants.ts — PURE, always-on validator of a small set of HARD safety couplings in the
// tuning config (panel P0-3). It gates NOTHING on its own; callers decide what to do with the result:
//   - the AUTONOMOUS apply path fails CLOSED on any violation (skip the apply, write an audited
//     "skipped: invariant violation" row) — it must NEVER throw, or a throw would wedge the scheduler tick;
//   - the manual tune route surfaces the same violations as WARNINGS, not blocks.
//
// Scope is intentionally minimal: only couplings whose violation could make an AUTONOMOUS weight apply
// unsafe. It does not re-validate every field (defaults.ts / clamps already do bounds work) — it checks
// the invariants that the auto-apply path RELIES ON being true.

import type { TuningSettings } from "./types";

export interface TuningInvariantViolation {
  /** Stable machine code for tests/telemetry. */
  code: string;
  /** Human-readable explanation. */
  message: string;
}

export interface TuningInvariantResult {
  ok: boolean;
  violations: TuningInvariantViolation[];
}

/**
 * PURE. Validate a small set of hard safety couplings in the tuning settings. Never throws.
 *
 * Checks:
 *  - sample gates are strictly positive when set (`minClosedLotsForWeightShift`, `shrinkPrior`,
 *    `recurringFactorMinCount`): a non-positive gate would let a zero-evidence apply through;
 *  - `sizingFloorPct <= sizingCeilingPct` when both set (an inverted band is an unsafe sizer config);
 *  - `autoApplyWeights ⇒ oosWithholdUnvalidated` (unless the explicit `autoApplyOverrideUnvalidated`
 *    override is set): autonomy must not run while the OOS gate is configured to KEEP unvalidated
 *    weight moves — that would defeat the very gate the autonomous path leans on;
 *  - `calibrationSizing ⇒ a valid per-band sample gate` (`minClosedLotsForWeightShift > 0`): calibrated
 *    sizing without a band gate can size off a 1-lot band.
 *
 * @param tuning the `policy.tuning` settings (may be undefined → treated as all-defaults, which is valid).
 */
export function validateTuningInvariants(tuning: TuningSettings | undefined): TuningInvariantResult {
  const violations: TuningInvariantViolation[] = [];
  const t = tuning ?? {};

  const positiveIfSet = (value: number | undefined, code: string, label: string): void => {
    if (typeof value === "number" && !(value > 0)) {
      violations.push({ code, message: `${label} must be > 0 when set (got ${value}).` });
    }
  };
  positiveIfSet(t.minClosedLotsForWeightShift, "min_closed_lots_nonpositive", "minClosedLotsForWeightShift");
  positiveIfSet(t.shrinkPrior, "shrink_prior_nonpositive", "shrinkPrior");
  positiveIfSet(t.recurringFactorMinCount, "recurring_factor_min_nonpositive", "recurringFactorMinCount");

  if (
    typeof t.sizingFloorPct === "number" &&
    typeof t.sizingCeilingPct === "number" &&
    t.sizingFloorPct > t.sizingCeilingPct
  ) {
    violations.push({
      code: "sizing_floor_above_ceiling",
      message: `sizingFloorPct (${t.sizingFloorPct}) must be <= sizingCeilingPct (${t.sizingCeilingPct}).`
    });
  }

  if (t.autoApplyWeights && t.oosWithholdUnvalidated === false && !t.autoApplyOverrideUnvalidated) {
    violations.push({
      code: "auto_apply_without_oos_withhold",
      message:
        "autoApplyWeights requires oosWithholdUnvalidated=true (or an explicit autoApplyOverrideUnvalidated) — " +
        "autonomy must not run while unvalidated weight moves are kept."
    });
  }

  if (t.calibrationSizing && typeof t.minClosedLotsForWeightShift === "number" && !(t.minClosedLotsForWeightShift > 0)) {
    violations.push({
      code: "calibration_without_band_gate",
      message: "calibrationSizing requires a positive minClosedLotsForWeightShift (per-band sample gate)."
    });
  }

  return { ok: violations.length === 0, violations };
}
