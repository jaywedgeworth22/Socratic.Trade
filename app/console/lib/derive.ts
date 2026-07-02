/** Client-side derivations over the DashboardSnapshot. These mirror server
 *  semantics (deriveExecutionState in src/lib/execution-mode.ts) — the words
 *  are load-bearing, the colors only reinforce. Nothing here fabricates data:
 *  every helper returns null/undefined when the snapshot can't answer. */

import type { DashboardSnapshot } from "../../dashboard-types";
import type {
  ConnectedAccount,
  EquityOrder,
  EquityPosition,
  ExecutionMode,
  PerformanceSummary,
  SystemState,
  TradingPolicy
} from "@/lib/types";

// ── Money-reality ────────────────────────────────────────────────────────────

export type RealityTone = "test" | "paper" | "live";

export interface RealityInfo {
  mode: ExecutionMode;
  tone: RealityTone;
  /** The load-bearing word. */
  word: "TEST" | "PAPER" | "LIVE";
  /** The load-bearing qualifier next to the word. */
  phrase: "practice money" | "real money";
  /** One-sentence honest clarification. */
  clarification: string;
  account?: ConnectedAccount;
}

export function activeConnectedAccount(snapshot: DashboardSnapshot): ConnectedAccount | undefined {
  return snapshot.connectedAccounts.find((a) => a.isActive);
}

export function realityForMode(mode: ExecutionMode | undefined): Pick<RealityInfo, "mode" | "tone" | "word" | "phrase" | "clarification"> {
  switch (mode) {
    case "broker/paper":
      return {
        mode,
        tone: "paper",
        word: "PAPER",
        phrase: "practice money",
        clarification: "Your broker's practice sandbox — real broker endpoints, zero real dollars."
      };
    case "broker/live":
      return {
        mode,
        tone: "live",
        word: "LIVE",
        phrase: "real money",
        clarification: "Orders here can spend your actual cash."
      };
    default:
      return {
        mode: "test/local",
        tone: "test",
        word: "TEST",
        phrase: "practice money",
        clarification: "Simulated by this app, marked to live prices. Not any broker's paper account."
      };
  }
}

/** Mirror of the server's deriveExecutionState(policy, activeAccount). */
export function deriveReality(snapshot: DashboardSnapshot): RealityInfo {
  const account = activeConnectedAccount(snapshot);
  const mode: ExecutionMode =
    snapshot.policy.paperMode || !account
      ? "test/local"
      : account.environment === "paper"
        ? "broker/paper"
        : "broker/live";
  return { ...realityForMode(mode), account };
}

export function realityForAccount(account: ConnectedAccount, policy: TradingPolicy): Pick<RealityInfo, "mode" | "tone" | "word" | "phrase" | "clarification"> {
  if (policy.paperMode) return realityForMode("test/local");
  if (account.broker === "test") return realityForMode("test/local");
  return realityForMode(account.environment === "paper" ? "broker/paper" : "broker/live");
}

// ── Run-state / authority words ──────────────────────────────────────────────

export interface StateInfo {
  state: SystemState;
  /** Compound plain-words label, e.g. "Running · Ask-first". */
  label: string;
  /** One-line honest explanation. */
  detail: string;
  tone: "pos" | "warn" | "neg" | "muted";
}

export function deriveStateInfo(policy: TradingPolicy): StateInfo {
  const authority = policy.strategyAuthority === "decide" ? "Autopilot" : "Ask-first";
  switch (policy.systemState) {
    case "active":
      return {
        state: "active",
        label: `Running · ${authority}`,
        detail:
          policy.strategyAuthority === "decide"
            ? "The strategy runs on schedule and may place orders itself, inside your guardrails."
            : "The strategy runs on schedule. Every trade waits for your approval.",
        tone: policy.strategyAuthority === "decide" ? "warn" : "pos"
      };
    case "close_only":
      return {
        state: "close_only",
        label: "Exit-only",
        detail: "No new buys. Protective exits keep working. This is the state circuit breakers set.",
        tone: "warn"
      };
    case "liquidating":
      return {
        state: "liquidating",
        label: "Winding down",
        detail: "Only sell orders, until the account is in cash. This sells things.",
        tone: "warn"
      };
    default:
      return {
        state: "halted",
        label: "Stopped",
        detail:
          "Nothing trades — no buys, no sells, and this app's automatic stops are paused too. Broker-held brackets keep resting at the broker. Nothing is sold.",
        tone: "neg"
      };
  }
}

export function authorityWord(policy: TradingPolicy): "Ask-first" | "Autopilot" {
  return policy.strategyAuthority === "decide" ? "Autopilot" : "Ask-first";
}

// ── Per-position protection status ───────────────────────────────────────────

export interface ProtectionInfo {
  /** Short cell text, or null when nothing protects the position (render "—"). */
  label: string | null;
  detail: string;
  tone: "pos" | "warn" | "muted";
}

const TERMINAL_ORDER_STATES = new Set(["filled", "cancelled", "canceled", "rejected", "expired", "failed", "done_for_day", "replaced"]);

function hasWorkingStop(orders: EquityOrder[], symbol: string): boolean {
  return orders.some(
    (o) =>
      o.symbol?.toUpperCase() === symbol.toUpperCase() &&
      (o.type === "stop_market" || o.type === "stop_limit") &&
      !TERMINAL_ORDER_STATES.has((o.state || "").toLowerCase())
  );
}

/** Honest protection derivation from what the snapshot actually carries:
 *  a resting broker stop order for the symbol, else the app-managed stop rules
 *  (which pause while Stopped), else nothing. */
export function deriveProtection(
  position: EquityPosition,
  orders: EquityOrder[],
  policy: TradingPolicy
): ProtectionInfo {
  if (hasWorkingStop(orders, position.symbol)) {
    return {
      label: "Broker stop",
      detail: "A stop order is resting at the broker. It keeps protecting even if this app is down or stopped.",
      tone: "pos"
    };
  }
  const rules = policy.riskRules;
  const stopPct = rules.trailingStopPct && rules.trailingStopPct > 0 ? rules.trailingStopPct : rules.stopLossPct;
  const trailing = !!(rules.trailingStopPct && rules.trailingStopPct > 0);
  if (typeof stopPct === "number" && stopPct > 0) {
    if (policy.systemState === "halted") {
      return {
        label: `App stop −${stopPct}% · paused`,
        detail: "App-managed stop rules are configured but paused while the system is Stopped. They resume when you start or switch to Exit-only.",
        tone: "warn"
      };
    }
    return {
      label: `App ${trailing ? "trailing " : ""}stop −${stopPct}%`,
      detail: "Managed by this app on its scheduler tick. It requires the app to be running and pauses if you Stop everything.",
      tone: "pos"
    };
  }
  return {
    label: null,
    detail: "No stop rule is configured and no broker stop order is resting for this symbol.",
    tone: "muted"
  };
}

// ── Day P&L (honest: derived from persisted snapshots, labeled as such) ──────

export interface DayPnl {
  pnl: number;
  pct: number;
  baselineAt: string;
  baselineEquity: number;
}

/** Change in equity vs the last persisted snapshot before today (local time)
 *  in the current mode's bucket. Null when there is no prior-day snapshot or
 *  no current equity — render "—", never invent. */
export function deriveDayPnl(
  performance: PerformanceSummary | undefined,
  mode: ExecutionMode,
  currentEquity: number | undefined
): DayPnl | null {
  if (!performance || typeof currentEquity !== "number" || !Number.isFinite(currentEquity)) return null;
  const curve = mode === "broker/live" ? performance.liveEquityCurve : performance.paperEquityCurve;
  if (!curve || curve.length === 0) return null;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let baseline: { timestamp: string; equity: number } | undefined;
  for (const point of curve) {
    const t = new Date(point.timestamp).getTime();
    if (Number.isFinite(t) && t < todayStart) baseline = point;
  }
  if (!baseline || !Number.isFinite(baseline.equity) || baseline.equity === 0) return null;
  const pnl = currentEquity - baseline.equity;
  return { pnl, pct: (pnl / baseline.equity) * 100, baselineAt: baseline.timestamp, baselineEquity: baseline.equity };
}

// ── Needs-attention inbox ────────────────────────────────────────────────────

export interface AttentionItem {
  id: string;
  tone: "neg" | "warn" | "accent";
  title: string;
  detail: string;
  href?: string;
}

export function deriveAttention(snapshot: DashboardSnapshot): AttentionItem[] {
  const items: AttentionItem[] = [];
  const pending = snapshot.pendingProposals.length;
  if (pending > 0) {
    items.push({
      id: "pending",
      tone: "accent",
      title: `${pending} trade ${pending === 1 ? "idea is" : "ideas are"} waiting for you`,
      detail: "Nothing happens until you approve or reject each one. Doing nothing lets them expire.",
      href: "/console/approvals"
    });
  }
  const state = snapshot.policy.systemState;
  if (state === "halted") {
    items.push({
      id: "halted",
      tone: "neg",
      title: "The strategy is stopped",
      detail:
        "No runs, no orders — and this app's automatic stops are paused. Broker-held brackets keep resting. Approving or rejecting proposals is refused while stopped.",
      href: "/console/guardrails"
    });
  } else if (state === "close_only") {
    items.push({
      id: "close-only",
      tone: "warn",
      title: "Exit-only mode",
      detail: "No new buys will happen. Protective sells still work. A circuit breaker or a person set this.",
      href: "/console/activity"
    });
  } else if (state === "liquidating") {
    items.push({
      id: "liquidating",
      tone: "warn",
      title: "Winding down",
      detail: "Only sell orders are allowed until the account is in cash."
    });
  }
  if (snapshot.llmConfigured === false) {
    items.push({
      id: "llm",
      tone: "warn",
      title: "No LLM key configured",
      detail: "Runs that generate proposals need one. Market data, positions, and guardrails still work without it."
    });
  }
  if (snapshot.accountReadiness && !snapshot.accountReadiness.ok) {
    items.push({
      id: "readiness",
      tone: "warn",
      title: "Account not ready to run",
      detail: snapshot.accountReadiness.detail
    });
  }
  const failed = (snapshot.recentProposals ?? []).filter((p) => p.status === "placing_failed");
  if (failed.length > 0) {
    items.push({
      id: "placing-failed",
      tone: "neg",
      title: `${failed.length} order ${failed.length === 1 ? "intent" : "intents"} awaiting reconciliation`,
      detail:
        "A broker call failed or its response was lost. The durable intent was recorded before the call, so it cannot double-place — the broker-truth sweep will resolve it. Do not retry manually.",
      href: "/console/activity"
    });
  }
  const recentKill = snapshot.notifications.filter((n) => n.type === "kill_switch").slice(0, 1);
  for (const n of recentKill) {
    // Only surface if it's fresh (last 48h) — older breaker events live in Activity.
    const t = new Date(n.createdAt).getTime();
    if (Number.isFinite(t) && Date.now() - t < 48 * 3600_000) {
      items.push({
        id: `kill-${n.id}`,
        tone: "neg",
        title: "A circuit breaker fired",
        detail: n.title,
        href: "/console/activity"
      });
    }
  }
  return items;
}

// ── Daily spend meter ────────────────────────────────────────────────────────

export interface SpendInfo {
  usedNotional: number;
  capNotional?: number;
  usedOrders: number;
  capOrders: number;
}

export function deriveSpend(snapshot: DashboardSnapshot): SpendInfo {
  return {
    usedNotional: snapshot.dailyStats?.notional ?? 0,
    capNotional: snapshot.policy.maxDailyNotional,
    usedOrders: snapshot.dailyStats?.openingOrderCount ?? snapshot.dailyStats?.orderCount ?? 0,
    capOrders: snapshot.policy.maxDailyOrders
  };
}
