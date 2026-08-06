/** Autonomous-action row verbs — tense-matched so a row never claims a trade
 *  happened when it didn't.
 *
 *  The Home "Autonomous actions" feed renders each row as `{SYMBOL} {verb}
 *  [status-chip]`. The verb used to be derived purely from the order side
 *  (past tense: "Bought"/"Sold"), regardless of whether anything executed — so a
 *  merely-proposed or BLOCKED decision read "AAPL Bought [Blocked]", falsely
 *  asserting a completed purchase. On a real-money app that is a trust bug, not
 *  cosmetics. `sideVerb` picks tense from lifecycle status: past tense only when
 *  an order actually reached the broker, infinitive ("Buy"/"Sell") otherwise. */

/** Past tense — used ONLY when the order actually executed. */
export const SIDE_LABEL: Record<string, string> = { buy: "Bought", sell: "Sold", short: "Shorted", cover: "Covered" };

/** Infinitive / intent — used for anything that hasn't executed
 *  (proposed, planned, blocked, rejected, error, pending, …). */
export const SIDE_INTENT: Record<string, string> = { buy: "Buy", sell: "Sell", short: "Short", cover: "Cover" };

/** True only for statuses that mean an order actually executed (filled). The
 *  canonical Socratic status for that is `filled`; the proposal-review path can
 *  also surface raw broker status `executed`. Everything else
 *  (proposed/planned/blocked/rejected/error/pending/approved/skipped/observed/placed)
 *  means nothing was executed yet. */
export function isExecutedStatus(status: string): boolean {
  return /^(filled|executed)$/i.test(status);
}

/** Terminal states where nothing reached the broker — the row must make it
 *  unambiguous that no order was placed. */
export function isNotPlacedStatus(status: string): boolean {
  return /^(blocked|rejected|failed|not_placed)$/i.test(status);
}

/** The verb for an autonomous-action row, tense-matched to lifecycle status.
 *  - No side (a pure observation) → "Observed".
 *  - Executed status → past tense ("Bought").
 *  - Anything not executed → infinitive intent ("Buy").
 *  - Unknown side → the raw side string passes through unchanged. */
export function sideVerb(side: string | null | undefined, status: string): string {
  if (!side) return "Observed";
  const map = isExecutedStatus(status) ? SIDE_LABEL : SIDE_INTENT;
  return map[side] ?? side;
}
