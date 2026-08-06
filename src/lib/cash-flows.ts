// External deposit/withdrawal inference — PURE, and deliberately dependency-free.
//
// Why this is its own module rather than living in `benchmark.ts` where it started:
// `app/console/lib/derive.ts` needs `inferExternalCashFlows` to compute a cash-flow-adjusted
// day P&L, and derive.ts is imported by ~a dozen "use client" components (the console chrome,
// the dashboard, the mobile PWA client, …). Importing it through benchmark.ts dragged the whole
// server graph into the browser bundle:
//
//   derive.ts → benchmark.ts → history.ts → db.ts (barrel: migrations, api-key crypto, …)
//
// which is how a client chunk ended up carrying the SQLite/migration/ENCRYPTION_KEY code and
// warning about a missing `ENCRYPTION_KEY` in the browser console. The flow math itself never
// needed any of that — it is arithmetic over an equity curve and a fill list.
//
// RULE: this file must stay free of runtime imports. Type-only imports are fine (they are erased
// at compile time); a value import from `./db`, `./history`, or anything that reaches them will
// silently re-attach the server graph to every console page. `history.ts` and the `db` barrel are
// marked `server-only`, so a regression fails the build instead of shipping quietly.

import type { EquityCurvePoint, FillEvent } from "./types";

/** Shared with benchmark.ts, which does the same date-collapsing and 2-dp rounding. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Normalize any timestamp (ms epoch | ISO datetime | YYYY-MM-DD) to a calendar date string. */
export function isoDate(ts: string | number | undefined): string | null {
  if (ts == null) return null;
  if (typeof ts === "number") {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(ts)) return ts.slice(0, 10);
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** A flow is only "external" when it clears both floors — below that, cash drift is
 *  indistinguishable from dividends/fees/rounding and must NOT be treated as a transfer. */
export const FLOW_MATERIALITY_PCT_OF_EQUITY = 0.5; // % of prior equity
export const FLOW_MATERIALITY_MIN_USD = 0.50;

type CurvePoint = {
  equity: number;
  cash?: number;
  positionsValue?: number;
  timestampMs: number;
};

function materialityThreshold(priorEquity: number): number {
  return Math.max((FLOW_MATERIALITY_PCT_OF_EQUITY / 100) * priorEquity, FLOW_MATERIALITY_MIN_USD);
}

/** True when the snapshot is essentially all cash (no meaningful open positions). */
function isAllCash(p: CurvePoint): boolean {
  const threshold = materialityThreshold(p.equity);
  // Prefer cash ≈ equity. positionsValue has been wrong/double-counted in the past; when cash
  // says the book is fully liquid, treat it as all-cash even if positionsValue is noisy.
  if (typeof p.cash === "number" && Number.isFinite(p.cash)) {
    return Math.abs(p.cash - p.equity) <= Math.max(FLOW_MATERIALITY_MIN_USD, 0.01 * p.equity);
  }
  if (typeof p.positionsValue === "number" && Number.isFinite(p.positionsValue)) {
    return Math.abs(p.positionsValue) < threshold;
  }
  return false;
}

/**
 * Infer external deposits/withdrawals per calendar date from the equity curve and recorded fills.
 *
 * Priority:
 *  1. All-cash → all-cash gaps: equity delta IS the external transfer (paper resets, ACH, etc.).
 *  2. Otherwise, when cash is present: (cash delta) − (trade cash from fills), with guards so a
 *     cash→positions conversion without a recorded fill is not counted as a withdrawal.
 *
 * Returns a map keyed by the PERIOD-END snapshot date. Pure — exported for direct unit testing.
 */
export function inferExternalCashFlows(
  equityCurve: EquityCurvePoint[],
  fills: FillEvent[] = []
): Map<string, number> {
  const flows = new Map<string, number>();
  // Collapse to one (last) point per calendar date, mirroring normalizeAgainstBenchmark.
  const byDate = new Map<string, CurvePoint>();
  for (const p of equityCurve) {
    const d = isoDate(p.timestamp);
    const t = new Date(p.timestamp).getTime();
    if (!d || !Number.isFinite(t)) continue;
    if (!Number.isFinite(p.equity) || p.equity <= 0) continue;
    const point: CurvePoint = { equity: p.equity, timestampMs: t };
    if (typeof p.cash === "number" && Number.isFinite(p.cash)) point.cash = p.cash;
    if (typeof p.positionsValue === "number" && Number.isFinite(p.positionsValue)) {
      point.positionsValue = p.positionsValue;
    }
    byDate.set(d, point);
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length < 2) return flows;

  const sortedFills = fills
    .map((f) => ({ t: new Date(f.filledAt).getTime(), side: f.side, notional: f.notional }))
    .filter((f) => Number.isFinite(f.t) && Number.isFinite(f.notional))
    .sort((a, b) => a.t - b.t);

  for (let i = 1; i < dates.length; i++) {
    const prev = byDate.get(dates[i - 1])!;
    const cur = byDate.get(dates[i])!;
    const threshold = materialityThreshold(prev.equity);
    const deltaEquity = cur.equity - prev.equity;

    // All-cash books have no market P&L between snapshots — any equity move is a transfer.
    // This is the paper-reset / deposit case that previously read as +30% "alpha".
    if (isAllCash(prev) && isAllCash(cur)) {
      if (Math.abs(deltaEquity) >= threshold) flows.set(dates[i], round2(deltaEquity));
      continue;
    }

    // Count absolute trade notional in the gap (used by missing-cash and residual guards).
    let tradeNotionalAbs = 0;
    let tradeCash = 0;
    for (const f of sortedFills) {
      if (f.t <= prev.timestampMs) continue;
      if (f.t > cur.timestampMs) break;
      tradeNotionalAbs += Math.abs(f.notional);
      tradeCash += f.side === "sell" || f.side === "cover" ? f.notional : -f.notional;
    }

    // Missing cash metadata: only invent a transfer when BOTH sides look flat (no positions)
    // AND there was essentially no trading — otherwise mark-to-market would be misread as ACH.
    if (typeof prev.cash !== "number" || typeof cur.cash !== "number") {
      const prevFlat =
        typeof prev.positionsValue === "number" ? Math.abs(prev.positionsValue) < threshold : true;
      const curFlat =
        typeof cur.positionsValue === "number" ? Math.abs(cur.positionsValue) < threshold : true;
      if (prevFlat && curFlat && tradeNotionalAbs < threshold && Math.abs(deltaEquity) >= threshold) {
        flows.set(dates[i], round2(deltaEquity));
      }
      continue;
    }

    const deltaCash = cur.cash - prev.cash;
    let flow = deltaCash - tradeCash;

    // Missing-fill guards: without trade receipts, a cash→stock conversion looks like a withdrawal.
    if (Math.abs(tradeCash) < 1e-9) {
      const deltaPos =
        typeof prev.positionsValue === "number" && typeof cur.positionsValue === "number"
          ? cur.positionsValue - prev.positionsValue
          : null;

      if (Math.abs(deltaCash) >= threshold && Math.abs(deltaEquity) < threshold) {
        // Cash moved, equity didn't — bought/sold positions, not a transfer.
        flow = 0;
      } else if (
        deltaPos != null &&
        ((deltaCash < -threshold && deltaPos > threshold) || (deltaCash > threshold && deltaPos < -threshold))
      ) {
        // Cash and positions moved in opposite directions — trade, not ACH.
        flow = 0;
      } else if (Math.abs(deltaCash - deltaEquity) < threshold) {
        // Cash and equity moved together — classic deposit/withdrawal.
        flow = deltaEquity;
      }
    }

    if (Math.abs(flow) >= threshold) flows.set(dates[i], round2(flow));
  }
  return flows;
}
