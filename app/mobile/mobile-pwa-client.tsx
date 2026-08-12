"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Bell,
  Check,
  ChevronDown,
  ChevronUp,
  CircleStop,
  ExternalLink,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Trash2,
  Wifi,
  WifiOff,
  X
} from "lucide-react";
import { deriveStateInfo, estimatedClosingPnl, isClosingOrder, positionMarkPrice, type StateInfo } from "../console/lib/derive";
import type { StrategyAuthority, SystemState } from "@/lib/types";
import { authorityLabel } from "../console/lib/labels";
import { requestedExitQuantity } from "@/lib/broker-held-orders";
import { modelDisplayName } from "../console/lib/models";
import { redTeamFailureMeta, redTeamVerdictLabel } from "../console/lib/red-team";
import { splitThesisRationale } from "../console/lib/thesis";
import { normalizeSymbol } from "@/lib/money";
import { MobileHeader } from "./components/MobileHeader";
import { MobileNavBar, type MobileTab } from "./components/MobileNavBar";
import { MobileHomeTab } from "./components/MobileHomeTab";
import { MobileProposalsTab } from "./components/MobileProposalsTab";

/** Hook to enforce WebKit scroll top boundary check (scrollTop === 0) and prevent body scroll chaining on iOS Safari */
export function usePreventScrollChaining<T extends HTMLElement = HTMLDivElement>() {
  const containerRef = useRef<T | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleTouchStart = () => {
      if (el.scrollTop === 0) {
        el.scrollTop = 1;
      } else if (el.scrollTop + el.clientHeight >= el.scrollHeight) {
        el.scrollTop = el.scrollHeight - el.clientHeight - 1;
      }
    };

    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
    };
  }, []);

  return containerRef;
}

type CommandStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type MobileCommand = {
  id: string;
  commandType: string;
  status: CommandStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
};
export type PendingProposal = {
  id: string;
  accountNumber?: string;
  executionMode?: string;
  estimatedNotional?: number;
  decision?: { socraticOverride?: { applied?: boolean } };
  proposal: {
    symbol: string;
    side: string;
    type: string;
    dollarAmount?: number;
    quantity?: number;
    rationale?: string;
    greenTeamRationale?: string;
    proposedByModel?: string;
    redTeamVerdict?: {
      verdict?: "approve" | "approve-at-half" | "reject";
      rejected: boolean;
      available: boolean;
      reason: string;
      model?: string;
      overridden?: boolean;
      failureKind?: "not_configured" | "timeout" | "provider_error" | "rate_limited" | "malformed_response";
    };
  };
};
export type MobileSnapshot = {
  currentUser?: { email?: string; userId: string };
  readiness: {
    hasAccount: boolean;
    hasUniverse: boolean;
    systemState: string;
    strategyAuthority: string;
    selectedAccountNumber: string | null;
    commandBacklog: { queued: number; running: number };
    activeConnectedAccount?: { id: string; label: string; broker: string; environment: string; accountNumber?: string } | null;
  };
  policy: {
    systemState: SystemState;
    strategyAuthority: StrategyAuthority;
    runDuringExtendedHours?: boolean;
    holdingHorizon?: string;
    maxOrderNotional?: number;
    maxOrderPctOfNav?: number;
    maxDailyNotional?: number;
    maxDailyPctOfNav?: number;
    maxDailyOrders?: number;
    requireTypedConfirmation?: boolean;
  };
  /** Raw session token from the server (`currentMarketSession()` — src/lib/market-hours.ts):
   *  "closed" | "regular" | "pre" | "post". Typed open so an unknown future token still renders. */
  marketSession?: string;
  scheduler?: { lastRunAt: string | null; nextRunAt: string | null };
  portfolio?: { totalMarketValue?: number; buyingPower?: number; cash?: number };
  positions?: Array<{ symbol: string; quantity: number; marketValue: number; averageCost?: number }>;
  pendingProposals?: PendingProposal[];
  connectedAccounts?: Array<{ id: string; label: string; broker: string; environment: string; isActive: boolean; accountNumber?: string }>;
  watchlist?: Array<{ symbol: string; addedAt: string }>;
  alerts?: Array<{ id: string; symbol: string; op: string; price: number; status: string }>;
  recentCommands?: MobileCommand[];
};
export type DeletionRequest = {
  requestId?: string;
  email?: string;
  userId: string;
  requiredText: string;
  expiresAt?: string;
  steps: string[];
};

function money(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function shortTime(value?: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleTimeString([], { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
}

function statusTone(status: CommandStatus): string {
  if (status === "succeeded") {
    return "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200";
  }
  if (status === "failed") return "border-red-300 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200";
  if (status === "running") return "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200";
  return "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200";
}

/** Humanized labels for mobile command types (command log + busy strip). API types stay
 *  dotted machine ids; only the user-facing surface is rewritten. Unknown types fall back
 *  to a plain title-case de-underscore so raw `snake.case` never reaches the operator. */
const COMMAND_LABELS: Record<string, string> = {
  "strategy.run_once": "Strategy run",
  "strategy.start": "Start strategy",
  "strategy.stop": "Stop",
  "strategy.close_only": "Close only",
  "strategy.liquidating": "Wind down",
  "proposal.approve": "Approve proposal",
  "proposal.reject": "Reject proposal",
  "account.activate": "Switch account",
  "watchlist.add": "Add to watchlist",
  "watchlist.remove": "Remove from watchlist",
  "alert.create": "Create alert",
  "alert.delete": "Delete alert"
};

export function commandLabel(value: string): string {
  if (value in COMMAND_LABELS) return COMMAND_LABELS[value];
  return value
    .replaceAll(".", " ")
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Authority glossary: raw propose/decide never shown — matches console Ask-first / Autopilot. */
export function strategyAuthorityLabel(value?: string | null): string {
  return authorityLabel(value).label || "-";
}

/** Compact one-line model attribution for a proposal card: which model proposed it, and which
 *  model reviewed it — or failed to (text-only on mobile; the console gets the logo badges). */
function modelAttributionLine(pending: PendingProposal): string | null {
  const proposal = pending.proposal;
  const parts: string[] = [];
  if (proposal.proposedByModel) parts.push(`Proposed by ${modelDisplayName(proposal.proposedByModel)}`);
  const verdict = proposal.redTeamVerdict;
  if (verdict?.available) {
    const reviewer = verdict.model ? ` — ${modelDisplayName(verdict.model)}` : "";
    parts.push(`Red team: ${redTeamVerdictLabel(verdict, pending.decision?.socraticOverride?.applied)}${reviewer}`);
  } else if (verdict) {
    const reviewer = verdict.model ? ` — ${modelDisplayName(verdict.model)}` : "";
    parts.push(`Red team FAILED (${redTeamFailureMeta(verdict.failureKind).label})${reviewer}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Estimated closing P/L for a sell/cover proposal against a matching held position — same
 *  math as console's estimatedClosingPnl (app/console/lib/derive.ts), reused rather than
 *  re-derived. The mobile snapshot's position rows already carry averageCost, so no extra
 *  fetch is needed. Null (and the card renders no line) when there's no matching position, no
 *  persisted average cost, or no share quantity on the proposal — never invented. */
function estimatedExitPnl(proposal: PendingProposal, positions: MobileSnapshot["positions"]) {
  const p = proposal.proposal;
  if (p.side !== "sell" && p.side !== "cover") return null;
  const position = positions?.find((item) => normalizeSymbol(item.symbol) === normalizeSymbol(p.symbol));
  if (!position || typeof position.averageCost !== "number") return null;
  // Same sign-consistency gate as the console card: the position under a stale card can flip or
  // close, and a sell over a now-short position is not a closing order.
  if (!isClosingOrder({ symbol: p.symbol, side: p.side }, { symbol: position.symbol, quantity: position.quantity })) return null;
  // requestedExitQuantity handles dollarAmount-sized exits too (parity with the console card),
  // capped to the current holding so a stale oversize exit proposal doesn't overstate the
  // estimate — same guard as the console card and closingOrderPnl in orders/lib.ts.
  const requested = requestedExitQuantity(p);
  const shares = requested != null ? Math.min(requested, Math.abs(position.quantity)) : undefined;
  // An exact-cost mark is the broker's no-quote fallback (marketValue = qty * averageCost) — a
  // fake $0.00 P/L; omit the line instead.
  const mark = positionMarkPrice(position) ?? undefined;
  const suspicious = mark !== undefined && position.averageCost > 0 && Math.abs(mark - position.averageCost) / position.averageCost < 1e-9;
  return estimatedClosingPnl({
    position: { quantity: position.quantity, averageCost: position.averageCost },
    shares,
    currentPrice: suspicious ? undefined : mark
  });
}

/** Receipt body of a proposal card — the console Wave-A2 collapsed pattern ported to the PWA.
 *  Collapsed (default): critic/model line, est. exit P/L, and a 2–3 line thesis summary with
 *  the [Sizing]/[Risk]/[Stale quote …] audit blocks stripped. "Show full reasoning" expands to
 *  the proposal's full rationale text (audit blocks and red-team notes included). Approve/
 *  reject controls live outside this component and are untouched. */
export function MobileProposalReceipt({
  pending,
  positions,
  defaultExpanded = false
}: {
  pending: PendingProposal;
  positions: MobileSnapshot["positions"];
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const p = pending.proposal;
  const attribution = modelAttributionLine(pending);
  const estPnl = estimatedExitPnl(pending, positions);
  const summary = proposalThesisSummary(p.rationale, p.greenTeamRationale);
  return (
    <>
      {attribution && <p className="mt-1 text-xs text-faint">{attribution}</p>}
      {estPnl && (
        <p className="mt-1 text-xs text-faint">
          Est. P/L:{" "}
          <span className={estPnl.pnl >= 0 ? "text-emerald-600 dark:text-emerald-300" : "text-red-600 dark:text-red-300"}>
            {money(estPnl.pnl)} ({estPnl.pnlPct >= 0 ? "+" : ""}
            {estPnl.pnlPct.toFixed(1)}%)
          </span>
        </p>
      )}
      {expanded
        ? p.rationale && <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted">{p.rationale}</p>
        : summary && <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-muted">{summary}</p>}
      {p.rationale && (
        <button
          type="button"
          className="mt-1 flex min-h-9 items-center gap-1 text-xs font-semibold text-accent"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" aria-hidden /> Hide full reasoning
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" aria-hidden /> Show full reasoning
            </>
          )}
        </button>
      )}
    </>
  );
}

/** Capitalized market-session token for the Market metric — same treatment as the iOS home
 *  card (`snapshot.marketSession.capitalized`): "regular" → "Regular", "pre" → "Pre". Missing
 *  session renders "-" (data unavailable), never a fabricated "Closed". */
export function marketSessionLabel(value?: string | null): string {
  const token = value?.trim();
  if (!token) return "-";
  return token
    .split(/[_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/** Collapsed-card thesis summary (console Wave-A2 port): the green-team thesis with the
 *  app-appended audit annotations stripped — the "\n\n[Sizing] …" / "\n\n[Risk] …" paragraphs
 *  (src/lib/strategy-risk.ts, src/lib/strategy.ts) and the inline " [Stale quote backup: …]"
 *  note (src/lib/policy.ts). They stay visible in the expanded full-reasoning view; this only
 *  keeps the collapsed 2–3 line summary to the actual thesis. */
export function proposalThesisSummary(rationale?: string, greenTeamRationale?: string): string | undefined {
  if (!rationale) return undefined;
  const green = splitThesisRationale(rationale, greenTeamRationale).greenTeam;
  // (?:^|\n\n): splitThesisRationale trims its result, so a rationale that is ONLY audit
  // paragraphs loses the leading blank line — match the block at string start too.
  const stripped = green
    .replace(/(?:^|\n\n)\[(?:Sizing|Risk)\][^]*?(?=\n\n|$)/g, "")
    .replace(/\s*\[Stale quote backup:[^\]]*\]/g, "")
    .trim();
  return stripped || undefined;
}

function liveApprovalText(symbol: string): string {
  return `APPROVE LIVE ${symbol.trim().toUpperCase()}`;
}

/** Run-state vocabulary comes from the console's shared deriveStateInfo — the PWA
 *  must never keep its own systemState→label map (it once said "Running" while the
 *  console said "Paused · market closed" for the same account). Null when there is
 *  no snapshot yet. */
export function mobileRunState(policy: MobileSnapshot["policy"] | undefined): StateInfo | null {
  if (!policy) return null;
  return deriveStateInfo({
    systemState: policy.systemState,
    strategyAuthority: policy.strategyAuthority,
    ...(typeof policy.runDuringExtendedHours === "boolean" ? { runDuringExtendedHours: policy.runDuringExtendedHours } : {})
  });
}

function orderTypeLabel(value?: string): string {
  if (!value) return "unknown";
  const map: Record<string, string> = {
    market: "Market",
    limit: "Limit",
    stop_market: "Stop-market",
    stop_limit: "Stop-limit"
  };
  return map[value] ?? value.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function executionModeLabel(value?: string): string {
  if (!value) return "mode unknown";
  const map: Record<string, string> = {
    "broker/live": "Live",
    "broker/paper": "Paper"
  };
  return map[value] ?? "mode unknown";
}

export type MobileCommandAvailability = {
  canSubmit: boolean;
  canSubmitAccountCommand: boolean;
  canSubmitTrading: boolean;
  canSubmitStop: boolean;
  /** Account switch is metadata-only and runs immediately server-side; allowed even when snapshot is stale. */
  canSubmitAccountSwitch: boolean;
};

export type MobileSnapshotFreshness = "unknown" | "refreshing" | "fresh" | "stale";

export type MobileSnapshotLoadResult =
  | { ok: true; snapshot: MobileSnapshot }
  | { ok: false; error: Error };

export const MOBILE_SNAPSHOT_TIMEOUT_MS = 45_000;

export async function requestMobileSnapshot(
  fetcher: (input: string, init: RequestInit) => Promise<Response> = fetch,
  timeoutMs = MOBILE_SNAPSHOT_TIMEOUT_MS,
  externalSignal?: AbortSignal
): Promise<MobileSnapshot> {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetcher("/api/mobile/snapshot", { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()) as MobileSnapshot;
  } catch (error) {
    if (timedOut) throw new Error(`Mobile snapshot request timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`);
    if (controller.signal.aborted) throw new Error("Mobile snapshot request was cancelled.");
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

export function createCoalescedMobileSnapshotLoader(request: () => Promise<MobileSnapshot>) {
  let inFlight: Promise<MobileSnapshotLoadResult> | null = null;
  let runAgain = false;

  const refresh = (): Promise<MobileSnapshotLoadResult> => {
    if (inFlight) {
      runAgain = true;
      return inFlight;
    }

    const execute = async (): Promise<MobileSnapshotLoadResult> => {
      let result: MobileSnapshotLoadResult;
      do {
        runAgain = false;
        try {
          result = { ok: true, snapshot: await request() };
        } catch (error) {
          result = { ok: false, error: error instanceof Error ? error : new Error("Failed to load mobile snapshot.") };
        }
      } while (runAgain);
      return result;
    };

    inFlight = execute().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return { refresh };
}

export function getMobileCommandAvailability(
  snapshot: MobileSnapshot | null,
  busyCommand: string | null,
  isOnline: boolean,
  freshness: MobileSnapshotFreshness
): MobileCommandAvailability {
  // `recentCommands` is durable history and can contain a stale queued/running row after a process
  // crash. It is useful status evidence, not a client lock: only this tab's active POST blocks a new
  // submission, while the server remains authoritative for real command conflicts.
  const canReachServer = snapshot !== null && isOnline && busyCommand === null;
  const canSubmit = canReachServer && freshness === "fresh";
  return {
    canSubmit,
    canSubmitAccountCommand: canSubmit && snapshot.readiness.hasAccount,
    canSubmitTrading: canSubmit && snapshot.readiness.hasAccount && snapshot.readiness.hasUniverse,
    // Halting is protective and does not depend on scan-universe or snapshot freshness. Once this
    // client has loaded one valid snapshot, keep STOP available through refreshes/stale-data errors.
    canSubmitStop: canReachServer,
    // Account switch (account.activate) is a pure active-pointer flip and now executes immediately
    // on the server — do not gate it on portfolio freshness. Users often switch away while data is
    // stale or a strategy run is marked in backlog history.
    canSubmitAccountSwitch: canReachServer,
  };
}

export function nextDraftAfterCommandAcceptance<T>(current: T, submitted: T, accepted: boolean, empty: T): T {
  return accepted && Object.is(current, submitted) ? empty : current;
}

export type ProposalActionFeedback =
  | { phase: "sending"; action: "approve" | "reject" }
  | { phase: "pending"; action: "approve" | "reject"; status: "queued" | "running" }
  | { phase: "failed"; action: "approve" | "reject"; message: string }
  | { phase: "succeeded"; action: "approve" | "reject" }
  | null;

function proposalActionFromCommandType(commandType: string): "approve" | "reject" {
  return commandType === "proposal.reject" ? "reject" : "approve";
}

/** Derives what the proposal card should show about its own approve/reject action. Commands are
 *  queued server-side and executed by an async worker, so "the POST succeeded" is NOT "the trade
 *  was approved" — this tracks the queued command through recentCommands so the card itself shows
 *  queued → running → succeeded/failed instead of silently doing nothing until a refresh. */
export function proposalActionFeedback(input: {
  proposalId: string;
  busyKey: string | null;
  notice?: { message: string; action: "approve" | "reject" };
  trackedCommand?: Pick<MobileCommand, "status" | "commandType" | "error">;
}): ProposalActionFeedback {
  if (input.busyKey === `proposal.approve:${input.proposalId}`) return { phase: "sending", action: "approve" };
  if (input.busyKey === `proposal.reject:${input.proposalId}`) return { phase: "sending", action: "reject" };
  if (input.notice) return { phase: "failed", action: input.notice.action, message: input.notice.message };
  const command = input.trackedCommand;
  if (!command) return null;
  const action = proposalActionFromCommandType(command.commandType);
  if (command.status === "queued" || command.status === "running") return { phase: "pending", action, status: command.status };
  if (command.status === "failed") {
    return { phase: "failed", action, message: command.error ?? "Command failed — see the command log below." };
  }
  if (command.status === "succeeded") return { phase: "succeeded", action };
  return null;
}

export function MobileSnapshotUnavailable({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-5 text-fg">
      <div
        className="w-full max-w-sm rounded-md border border-red-300 bg-red-50 p-4 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100"
        role="alert"
      >
        <h1 className="text-base font-semibold">Mobile data unavailable</h1>
        <p className="mt-2 text-sm">No account, market, proposal, or position status is shown until current data loads.</p>
        <p className="mt-2 break-words text-xs opacity-80">{error}</p>
        <button
          className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-red-300 bg-bg px-3 text-sm font-semibold text-fg active:scale-[0.99] dark:border-red-500/40"
          onClick={onRetry}
        >
          <RefreshCw className="h-4 w-4" />
          Retry
        </button>
      </div>
    </main>
  );
}

export function MobilePwaClient() {
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<MobileTab>("home");
  const [busyCommand, setBusyCommand] = useState<string | null>(null);
  // Which specific control was tapped (e.g. "proposal.approve:<id>") so only that button spins,
  // instead of every disabled button looking equally dead while a command posts.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // proposalId -> queued command id, so the card can follow its own command through
  // queued/running/succeeded/failed in recentCommands (commands execute async server-side).
  const [proposalCommandIds, setProposalCommandIds] = useState<Record<string, string>>({});
  // proposalId -> submit-time failure that should render on the card itself, not just the top banner.
  const [proposalNotices, setProposalNotices] = useState<Record<string, { message: string; action: "approve" | "reject" }>>({});
  const [dangerZoneOpen, setDangerZoneOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [symbolInput, setSymbolInput] = useState("");
  const [alertInput, setAlertInput] = useState({ symbol: "", op: ">", price: "" });
  const [liveTextByProposal, setLiveTextByProposal] = useState<Record<string, string>>({});
  const [deletionRequest, setDeletionRequest] = useState<DeletionRequest | null>(null);
  const [deleteIdentity, setDeleteIdentity] = useState("");
  const [deletePhrase, setDeletePhrase] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [snapshotFreshness, setSnapshotFreshness] = useState<MobileSnapshotFreshness>("unknown");
  const [lastSnapshotAt, setLastSnapshotAt] = useState<string | null>(null);
  // Starts true so server-rendered/first-paint markup matches the client
  // (navigator is unavailable during SSR); corrected immediately on mount.
  const [isOnline, setIsOnline] = useState(true);
  const mountedRef = useRef(true);
  const snapshotRef = useRef<MobileSnapshot | null>(null);
  const activeSnapshotControllerRef = useRef<AbortController | null>(null);
  const snapshotLoaderRef = useRef<ReturnType<typeof createCoalescedMobileSnapshotLoader> | null>(null);
  const containerRef = usePreventScrollChaining<HTMLDivElement>();

  const load = useCallback(async (): Promise<boolean> => {
    if (!mountedRef.current) return false;
    setError(null);
    setSnapshotFreshness(snapshotRef.current ? "refreshing" : "unknown");
    const result = await snapshotLoaderRef.current!.refresh();
    if (!mountedRef.current) return false;
    if (result.ok) {
      snapshotRef.current = result.snapshot;
      setSnapshot(result.snapshot);
      setLastSnapshotAt(new Date().toISOString());
      setSnapshotFreshness("fresh");
      setError(null);
      return true;
    }
    setSnapshotFreshness(snapshotRef.current ? "stale" : "unknown");
    setError(result.error.message);
    return false;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!snapshotLoaderRef.current) {
      snapshotLoaderRef.current = createCoalescedMobileSnapshotLoader(async () => {
        if (!mountedRef.current) throw new Error("Mobile snapshot request was cancelled.");
        const controller = new AbortController();
        activeSnapshotControllerRef.current = controller;
        try {
          return await requestMobileSnapshot(fetch, MOBILE_SNAPSHOT_TIMEOUT_MS, controller.signal);
        } finally {
          if (activeSnapshotControllerRef.current === controller) activeSnapshotControllerRef.current = null;
        }
      });
    }
    void load().finally(() => {
      if (mountedRef.current) setLoading(false);
    });
    return () => {
      mountedRef.current = false;
      activeSnapshotControllerRef.current?.abort();
    };
  }, [load]);

  const retryInitialLoad = async () => {
    setLoading(true);
    await load();
    if (mountedRef.current) setLoading(false);
  };

  useEffect(() => {
    const events = new EventSource("/api/mobile/events");
    const refresh = () => {
      void load();
    };
    events.addEventListener("mobile.command", refresh);
    events.addEventListener("dashboard.run-complete", refresh);
    events.addEventListener("dashboard.proposal", refresh);
    events.addEventListener("dashboard.order", refresh);
    events.addEventListener("dashboard.market-data", refresh);
    events.addEventListener("dashboard.dirty", refresh);
    return () => events.close();
  }, [load]);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    const onOnline = () => {
      setIsOnline(true);
      void load();
    };
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [load]);

  useEffect(() => {
    const onFocus = () => void load();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load]);

  const submitCommand = async (
    commandType: string,
    payload: Record<string, unknown> = {},
    opts: { key?: string; proposal?: { id: string; action: "approve" | "reject" } } = {}
  ): Promise<boolean> => {
    setBusyCommand(commandType);
    setBusyKey(opts.key ?? commandType);
    setError(null);
    if (opts.proposal) {
      const proposalId = opts.proposal.id;
      setProposalNotices((prev) => {
        if (!(proposalId in prev)) return prev;
        const next = { ...prev };
        delete next[proposalId];
        return next;
      });
    }
    try {
      const response = await fetch("/api/mobile/commands", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `${commandType}:${crypto.randomUUID()}` },
        body: JSON.stringify({
          commandType,
          payload,
          client: { platform: "web", appVersion: "pwa" }
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Command failed.");
      const acceptedCommandId = typeof (body as { command?: { id?: unknown } }).command?.id === "string"
        ? (body as { command: { id: string } }).command.id
        : null;
      if (opts.proposal && acceptedCommandId && mountedRef.current) {
        const proposalId = opts.proposal.id;
        setProposalCommandIds((prev) => ({ ...prev, [proposalId]: acceptedCommandId }));
      }
      const refreshed = await load();
      if (!refreshed && mountedRef.current) {
        setError((current) => `Command accepted, but current mobile data could not be refreshed: ${current ?? "Refresh failed."}`);
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Command failed.";
      if (opts.proposal && mountedRef.current) {
        const failed = opts.proposal;
        setProposalNotices((prev) => ({ ...prev, [failed.id]: { message, action: failed.action } }));
      } else {
        setError(message);
      }
      return false;
    } finally {
      setBusyCommand(null);
      setBusyKey(null);
    }
  };

  const startDeletion = async () => {
    setDeleteBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/mobile/account-deletion/request");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not start deletion.");
      setDeletionRequest(body.deletionRequest);
      setDeleteIdentity("");
      setDeletePhrase("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start deletion.");
    } finally {
      setDeleteBusy(false);
    }
  };

  const confirmDeletion = async () => {
    if (!deletionRequest) return;
    setDeleteBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/mobile/account-deletion/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          typedIdentity: deleteIdentity,
          typedText: deletePhrase
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not delete account.");
      window.location.href = body.logoutUrl ?? "/logout";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete account.");
    } finally {
      setDeleteBusy(false);
    }
  };

  const activeCommand = useMemo(() => snapshot?.recentCommands?.find((c) => c.status === "running" || c.status === "queued"), [snapshot]);
  const pendingProposals = snapshot?.pendingProposals ?? [];
  const positions = snapshot?.positions ?? [];
  const watchlist = snapshot?.watchlist ?? [];
  const alerts = snapshot?.alerts ?? [];
  const connectedAccounts = snapshot?.connectedAccounts ?? [];
  const commandAvailability = useMemo(
    () => getMobileCommandAvailability(snapshot, busyCommand, isOnline, snapshotFreshness),
    [snapshot, busyCommand, isOnline, snapshotFreshness]
  );
  const runState = mobileRunState(snapshot?.policy);

  if (loading) {
    return (
      <main className="grid min-h-dvh place-items-center bg-bg px-5 text-fg">
        <div className="flex items-center gap-3 text-sm text-muted">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading mobile control
        </div>
      </main>
    );
  }

  if (!snapshot) {
    return (
      <MobileSnapshotUnavailable
        error={error ?? "Failed to load current mobile data."}
        onRetry={() => void retryInitialLoad()}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className="min-h-dvh bg-bg pb-[calc(env(safe-area-inset-bottom)+72px)] text-fg overscroll-y-contain overflow-y-auto"
      style={{ overscrollBehaviorY: "contain" }}
    >
      <MobileHeader
        snapshot={snapshot}
        snapshotFreshness={snapshotFreshness}
        commandAvailability={commandAvailability}
        busyCommand={busyCommand}
        connectedAccounts={connectedAccounts}
        onRefresh={() => void load()}
        onAccountChange={(selectedId) => {
          void submitCommand("account.activate", { accountId: selectedId }, { key: `account.activate:${selectedId}` });
        }}
      />

      <div className="mx-auto max-w-xl space-y-4 px-4 py-4">
        {!isOnline && (
          <div
            className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
            role="status"
          >
            <WifiOff className="h-4 w-4 shrink-0" />
            Offline — last snapshot still shown. Reconnect to send commands (including Stop).
          </div>
        )}
        {isOnline && snapshotFreshness === "refreshing" && (
          <div
            className="flex items-center gap-2 rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100"
            role="status"
          >
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            Refreshing current data — new commands are paused; Stop remains available.
          </div>
        )}
        {isOnline && snapshotFreshness === "stale" && (
          <div
            className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
            role="status"
          >
            <ShieldAlert className="h-4 w-4 shrink-0" />
            Snapshot may be stale — controls stay up. New commands are paused; Stop remains available.
          </div>
        )}
        {error && (
          <div
            className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100"
            role="alert"
          >
            {error}
          </div>
        )}

        {activeTab === "home" ? (
          <MobileHomeTab
            snapshot={snapshot}
            runState={runState}
            commandAvailability={commandAvailability}
            busyKey={busyKey}
            activeCommand={activeCommand}
            positions={positions}
            watchlist={watchlist}
            alerts={alerts}
            symbolInput={symbolInput}
            setSymbolInput={setSymbolInput}
            alertInput={alertInput}
            setAlertInput={setAlertInput}
            dangerZoneOpen={dangerZoneOpen}
            setDangerZoneOpen={setDangerZoneOpen}
            deletionRequest={deletionRequest}
            deleteIdentity={deleteIdentity}
            setDeleteIdentity={setDeleteIdentity}
            deletePhrase={deletePhrase}
            setDeletePhrase={setDeletePhrase}
            deleteBusy={deleteBusy}
            snapshotFreshness={snapshotFreshness}
            lastSnapshotAt={lastSnapshotAt}
            isOnline={isOnline}
            onSubmitCommand={submitCommand}
            onStartDeletion={() => void startDeletion()}
            onConfirmDeletion={() => void confirmDeletion()}
          />
        ) : (
          <MobileProposalsTab
            snapshot={snapshot}
            pendingProposals={pendingProposals}
            commandAvailability={commandAvailability}
            busyKey={busyKey}
            liveTextByProposal={liveTextByProposal}
            setLiveTextByProposal={setLiveTextByProposal}
            proposalCommandIds={proposalCommandIds}
            proposalNotices={proposalNotices}
            onSubmitCommand={submitCommand}
          />
        )}
      </div>

      <MobileNavBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        pendingCount={pendingProposals.length}
      />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-h-20 rounded-md border border-line bg-surface p-3">
      <p className="text-xs uppercase tracking-wide text-faint">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold">{value}</p>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed border-line px-3 py-4 text-center text-sm text-faint">
      {label}
    </div>
  );
}
