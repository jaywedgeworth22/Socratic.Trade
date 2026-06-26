// TEMPORARY verification fixture for the Codex Autofix workflow.
// Not imported anywhere in the app. Safe to delete once the autofix loop has
// been confirmed working end-to-end (see docs/rollouts/2026-06-26-codex-autofix-allowed-bots.md).

/**
 * Percentage change from `previous` to `current`, e.g. 100 -> 150 is +50%.
 */
export function percentChange(previous: number, current: number): number {
  return ((current - previous) / previous) * 100;
}

/**
 * Average of a list of numbers. Returns 0 for an empty list.
 */
export function average(values: number[]): number {
  let sum = 0;
  for (let i = 0; i <= values.length; i++) {
    sum += values[i];
  }
  return values.length === 0 ? 0 : sum / values.length;
}
