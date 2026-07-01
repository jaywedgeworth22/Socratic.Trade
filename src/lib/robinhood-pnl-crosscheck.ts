import { callRobinhoodMcpTool } from "./robinhood";
import { getPerformanceSummary } from "./performance";

// Rough sanity-check tolerance. Robinhood's own realized-gain bucketing uses its own
// timezone, wash-sale, and asset-class rules that will never line up exactly with this
// app's FIFO lot accounting, so this is a "same ballpark" alarm, not a reconciliation.
const TOLERANCE_PCT = 5;

export interface RealizedPnlCrossCheck {
  appRealizedPnl: number;
  robinhoodRealizedPnl: number | undefined;
  discrepancyAbs: number | undefined;
  discrepancyPct: number | undefined;
  withinTolerance: boolean | undefined;
}

/**
 * Independent sanity check of this app's own realized P&L against Robinhood's bucketed
 * `get_realized_pnl` for the same account. Read-only diagnostic — never places or reconciles.
 *
 * The app number is the LIVE realized P&L (Robinhood is a real broker, so its fills are `live`).
 * When Robinhood isn't connected or the call fails, the Robinhood/discrepancy fields come back
 * undefined rather than throwing, so a caller always gets the app figure back.
 */
export async function crossCheckRealizedPnl(
  userId: string,
  accountNumber: string,
  opts?: { span?: string }
): Promise<RealizedPnlCrossCheck> {
  const appRealizedPnl = getPerformanceSummary(accountNumber, {}, userId).liveRealizedPnl;

  let robinhoodRealizedPnl: number | undefined;
  try {
    const raw = await callRobinhoodMcpTool(userId, "get_realized_pnl", {
      account_number: accountNumber,
      span: opts?.span ?? "3month"
    });
    robinhoodRealizedPnl = parseRealizedPnl(raw);
  } catch {
    robinhoodRealizedPnl = undefined;
  }

  if (robinhoodRealizedPnl === undefined) {
    return { appRealizedPnl, robinhoodRealizedPnl: undefined, discrepancyAbs: undefined, discrepancyPct: undefined, withinTolerance: undefined };
  }

  const discrepancyAbs = Math.abs(appRealizedPnl - robinhoodRealizedPnl);
  // Percent is relative to Robinhood's figure (the independent reference). When it's ~0, fall
  // back to an absolute-only check so a tiny reference doesn't blow the percentage up to Infinity.
  const denom = Math.abs(robinhoodRealizedPnl);
  const discrepancyPct = denom > 1e-9 ? (discrepancyAbs / denom) * 100 : undefined;
  const withinTolerance = discrepancyPct !== undefined ? discrepancyPct <= TOLERANCE_PCT : discrepancyAbs <= 1e-9;

  return { appRealizedPnl, robinhoodRealizedPnl, discrepancyAbs, discrepancyPct, withinTolerance };
}

// Robinhood's get_realized_pnl bucketing keys vary; pull the total realized gain defensively.
function parseRealizedPnl(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const direct = firstMoney(row, [
    "total_realized_pnl",
    "totalRealizedPnl",
    "realized_pnl",
    "realizedPnl",
    "total_realized_gain",
    "totalRealizedGain",
    "realized_gain",
    "realizedGain",
    "total"
  ]);
  if (direct !== undefined) return direct;

  // Some shapes return only per-bucket rows; sum their realized-gain fields.
  const buckets = Array.isArray(row.results) ? row.results : Array.isArray(row.buckets) ? row.buckets : undefined;
  if (buckets) {
    let sum = 0;
    let matched = false;
    for (const entry of buckets) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const value = firstMoney(entry as Record<string, unknown>, ["realized_pnl", "realizedPnl", "realized_gain", "realizedGain", "pnl", "gain"]);
      if (value !== undefined) {
        sum += value;
        matched = true;
      }
    }
    if (matched) return sum;
  }
  return undefined;
}

function firstMoney(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined || value === "") continue;
    const parsed = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
