/** Presentation of the strategy bar's "Last run ..." line on the console home.
 *
 *  The reason a run failed is already sitting on the very row that renders the
 *  status: `finishStrategyRun` persists it as `summary` on the failure path
 *  (src/lib/strategy.ts), the stale-run sweep writes a human-readable one too
 *  (src/lib/db-execution.ts), and the runs query reads it straight back. The
 *  console home used to drop it on the floor and render only "Last run failed .
 *  23h ago", so the one place that already knew WHY told you nothing and the
 *  only way to find out was to open the Journal and expand the run.
 *
 *  Kept as a pure function rather than a component because app/console/page.tsx
 *  is an app-router page file: Next 16 type-checks its exports against a
 *  whitelist (default / metadata / dynamic / ...), so anything extra exported
 *  from it fails `tsc --noEmit` and the build. A helper module can be imported
 *  by the page and unit-tested on its own.
 */

import type { StrategyRunRow } from "@/lib/types";

/** The inline cause is truncated to this many characters. Long enough for the
 *  common one-sentence failures ("Kill switch is active.") without pushing the
 *  spend/authority block off the right edge of the strategy bar. The full text
 *  always survives in the tooltip. */
export const LAST_RUN_CAUSE_CHARS = 60;

export interface LastRunPresentation {
  /** Tone the line negative and show the cause inline. */
  failed: boolean;
  /** Full persisted summary for the `title` tooltip; undefined when the run recorded none. */
  title: string | undefined;
  /** Truncated cause to render inline, or undefined when there is nothing to render. */
  cause: string | undefined;
}

export function describeLastRun(run: Pick<StrategyRunRow, "status" | "summary">): LastRunPresentation {
  const summary = run.summary?.trim() || undefined;
  const failed = run.status === "failed";
  return {
    failed,
    title: summary,
    // Inline text for failures ONLY. `skipped` is the routine pre-decision gate
    // (market closed, budget spent) and the strategy bar already renders
    // deriveStateInfo's "Paused . market closed" chip two elements to the left,
    // so echoing it here would append a duplicate explanation to every
    // off-hours tick. Skipped runs keep the tooltip and nothing more.
    cause: failed && summary ? truncate(summary, LAST_RUN_CAUSE_CHARS) : undefined
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}...` : text;
}
