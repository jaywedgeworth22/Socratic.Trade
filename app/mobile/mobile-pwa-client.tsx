"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Bell,
  Check,
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
import { estimatedClosingPnl, isClosingOrder, positionMarkPrice } from "../console/lib/derive";
import { requestedExitQuantity } from "@/lib/broker-held-orders";
import { modelDisplayName } from "../console/lib/models";
import { redTeamFailureMeta, redTeamVerdictLabel } from "../console/lib/red-team";
import { normalizeSymbol } from "@/lib/money";

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
type PendingProposal = {
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
    systemState: string;
    strategyAuthority: string;
    holdingHorizon?: string;
    maxOrderNotional?: number;
    maxOrderPctOfNav?: number;
    maxDailyNotional?: number;
    maxDailyPctOfNav?: number;
    maxDailyOrders?: number;
    requireTypedConfirmation?: boolean;
  };
  marketSession?: { label?: string; isOpen?: boolean };
  scheduler?: { lastRunAt: string | null; nextRunAt: string | null };
  portfolio?: { totalMarketValue?: number; buyingPower?: number; cash?: number };
  positions?: Array<{ symbol: string; quantity: number; marketValue: number; averageCost?: number }>;
  pendingProposals?: PendingProposal[];
  connectedAccounts?: Array<{ id: string; label: string; broker: string; environment: string; isActive: boolean; accountNumber?: string }>;
  watchlist?: Array<{ symbol: string; addedAt: string }>;
  alerts?: Array<{ id: string; symbol: string; op: string; price: number; status: string }>;
  recentCommands?: MobileCommand[];
};
type DeletionRequest = {
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
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function statusTone(status: CommandStatus): string {
  if (status === "succeeded") {
    return "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200";
  }
  if (status === "failed") return "border-red-300 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200";
  if (status === "running") return "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200";
  return "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200";
}

function commandLabel(value: string): string {
  return value.replaceAll(".", " / ").replaceAll("_", " ");
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

function liveApprovalText(symbol: string): string {
  return `APPROVE LIVE ${symbol.trim().toUpperCase()}`;
}

function systemStateLabel(value?: string | null): string {
  if (!value) return "unknown";
  const map: Record<string, string> = {
    active: "Running",
    halted: "Stopped",
    close_only: "Close-only",
    liquidating: "Winding down"
  };
  return map[value] ?? value.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
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
    <main className="min-h-dvh bg-bg pb-[calc(env(safe-area-inset-bottom)+24px)] text-fg">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/95 px-4 pt-[calc(env(safe-area-inset-top)+12px)] backdrop-blur">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-3 pb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-faint">
              <Smartphone className="h-3.5 w-3.5" />
              Mobile control
            </div>
            <h1 className="truncate text-lg font-semibold">Socratic Trade</h1>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/console"
              className="grid h-11 w-11 place-items-center rounded-md border border-line bg-surface text-muted active:scale-95"
              aria-label="Open full console"
              title="Open the full desktop console"
            >
              <ExternalLink className="h-5 w-5" />
            </Link>
            <button
              className="grid h-11 w-11 place-items-center rounded-md border border-line bg-surface text-muted active:scale-95 disabled:opacity-50"
              disabled={snapshotFreshness === "refreshing"}
              onClick={() => void load()}
              aria-label="Refresh mobile snapshot"
              title="Refresh"
            >
              <RefreshCw className={`h-5 w-5 ${snapshotFreshness === "refreshing" ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {connectedAccounts.length > 0 && (
          <div className="mx-auto flex max-w-xl items-center gap-2 pb-3 pt-1">
            <div className="relative min-w-0 flex-1">
              <select
                className="min-h-10 w-full appearance-none rounded-md border border-line bg-surface px-3 py-1.5 pr-8 text-sm font-medium text-fg outline-none focus:border-accent disabled:opacity-50"
                value={connectedAccounts.find((a) => a.isActive)?.id ?? ""}
                disabled={!commandAvailability.canSubmitAccountSwitch || busyCommand === "account.activate"}
                onChange={(e) => {
                  const selectedId = e.target.value;
                  if (!selectedId || selectedId === connectedAccounts.find((a) => a.isActive)?.id) return;
                  void submitCommand("account.activate", { accountId: selectedId }, { key: `account.activate:${selectedId}` });
                }}
                aria-label="Select connected account"
              >
                {connectedAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.label} ({account.broker} · {account.environment}
                    {account.accountNumber ? ` · ${account.accountNumber}` : ""})
                    {account.isActive ? " ✓ Active" : ""}
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted">
                {busyCommand === "account.activate" ? (
                  <Loader2 className="h-4 w-4 animate-spin text-accent" />
                ) : (
                  <span className="text-xs">▼</span>
                )}
              </div>
            </div>

            {snapshot?.currentUser?.email && (
              <a
                href="/logout"
                className="flex min-h-10 shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-xs font-semibold text-muted hover:text-fg active:scale-95"
                title={`Sign out (${snapshot.currentUser.email})`}
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Sign out</span>
              </a>
            )}
          </div>
        )}
      </header>

      <div className="mx-auto max-w-xl space-y-4 px-4 py-4">
        {!isOnline && (
          <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
            <WifiOff className="h-4 w-4 shrink-0" />
            Offline — data may be stale
          </div>
        )}
        {snapshotFreshness === "refreshing" && (
          <div
            className="flex items-center gap-2 rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100"
            role="status"
          >
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            Refreshing current data — new commands are paused; Stop remains available.
          </div>
        )}
        {snapshotFreshness === "stale" && (
          <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            Current data could not be verified. New commands are paused; Stop remains available.
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

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-faint">Mode</p>
              <p className="text-xl font-semibold">{systemStateLabel(snapshot?.readiness.systemState)}</p>
            </div>
            <div className="rounded-md border border-line bg-surface px-3 py-2 text-right">
              <p className="text-xs text-faint">Authority</p>
              <p className="text-sm font-medium capitalize">{snapshot?.readiness.strategyAuthority ?? "-"}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              className="flex min-h-12 items-center justify-center gap-2 rounded-md bg-emerald-500 px-3 text-sm font-semibold text-black disabled:opacity-50"
              disabled={!commandAvailability.canSubmitTrading}
              onClick={() => void submitCommand("strategy.run_once")}
            >
              {busyKey === "strategy.run_once" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
              Run once
            </button>
            <button
              className="flex min-h-12 items-center justify-center gap-2 rounded-md bg-accent px-3 text-sm font-semibold text-accent-fg disabled:opacity-50"
              disabled={!commandAvailability.canSubmitTrading}
              onClick={() => void submitCommand("strategy.start")}
            >
              {busyKey === "strategy.start" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wifi className="h-4 w-4" />}
              Start
            </button>
            <button
              className="flex min-h-12 items-center justify-center gap-2 rounded-md border border-line bg-surface px-3 text-sm font-semibold text-fg disabled:opacity-50"
              disabled={!commandAvailability.canSubmitAccountCommand}
              onClick={() => void submitCommand("strategy.close_only")}
            >
              {busyKey === "strategy.close_only" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
              Close only
            </button>
            <button
              className="flex min-h-12 items-center justify-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 text-sm font-semibold text-red-700 disabled:opacity-50 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100"
              disabled={!commandAvailability.canSubmitStop}
              onClick={() => void submitCommand("strategy.stop")}
            >
              {busyKey === "strategy.stop" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleStop className="h-4 w-4" />}
              Stop
            </button>
          </div>

          {activeCommand && (
            <div className={`rounded-md border px-3 py-2 text-sm ${statusTone(activeCommand.status)}`}>
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4" />
                <span className="capitalize">{commandLabel(activeCommand.commandType)}</span>
                <span className="ml-auto capitalize">{activeCommand.status}</span>
              </div>
            </div>
          )}
        </section>

        <section className="grid grid-cols-2 gap-2">
          <Metric label="Equity" value={money(snapshot?.portfolio?.totalMarketValue)} />
          <Metric label="Buying power" value={money(snapshot?.portfolio?.buyingPower)} />
          <Metric label="Account" value={snapshot?.readiness.activeConnectedAccount?.label ?? "None"} />
          <Metric label="Market" value={snapshot?.marketSession?.label ?? (snapshot?.marketSession?.isOpen ? "Open" : "Closed")} />
        </section>


        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Proposals</h2>
            <span className="text-xs text-faint">{pendingProposals.length}</span>
          </div>
          {pendingProposals.length === 0 ? (
            <Empty label="No pending proposals" />
          ) : (
            pendingProposals.map((proposal) => {
              const live = proposal.executionMode === "broker/live";
              // Owner preference: with typed confirmation off, a live approval is one-click (the server
              // honors the same flag via executeProposal). Mirrors console approval-card.tsx.
              const willPromptTyped = live && snapshot?.policy.requireTypedConfirmation !== false;
              const typedText = liveTextByProposal[proposal.id] ?? "";
              const expectedLiveText = liveApprovalText(proposal.proposal.symbol);
              const livePhraseMatches = !willPromptTyped || typedText.trim().toUpperCase() === expectedLiveText;
              const estPnl = estimatedExitPnl(proposal, snapshot?.positions);
              const trackedCommandId = proposalCommandIds[proposal.id];
              const feedback = proposalActionFeedback({
                proposalId: proposal.id,
                busyKey,
                notice: proposalNotices[proposal.id],
                trackedCommand: trackedCommandId
                  ? snapshot?.recentCommands?.find((command) => command.id === trackedCommandId)
                  : undefined
              });
              const actionInFlight = feedback?.phase === "sending" || feedback?.phase === "pending";
              const actionSettled = feedback?.phase === "succeeded";
              return (
                <div key={proposal.id} className="rounded-md border border-line bg-surface p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-base font-semibold">{proposal.proposal.symbol}</p>
                      <p className="text-xs uppercase text-faint">
                        {proposal.proposal.side} · {orderTypeLabel(proposal.proposal.type)} · {executionModeLabel(proposal.executionMode)}
                      </p>
                    </div>
                    <p className="text-sm font-medium">{money(proposal.estimatedNotional)}</p>
                  </div>
                  {modelAttributionLine(proposal) && (
                    <p className="mt-1 text-xs text-faint">{modelAttributionLine(proposal)}</p>
                  )}
                  {estPnl && (
                    <p className="mt-1 text-xs text-faint">
                      Est. P/L:{" "}
                      <span className={estPnl.pnl >= 0 ? "text-emerald-600 dark:text-emerald-300" : "text-red-600 dark:text-red-300"}>
                        {money(estPnl.pnl)} ({estPnl.pnlPct >= 0 ? "+" : ""}
                        {estPnl.pnlPct.toFixed(1)}%)
                      </span>
                    </p>
                  )}
                  {proposal.proposal.rationale && (
                    <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-muted">{proposal.proposal.rationale}</p>
                  )}
                  {willPromptTyped && (
                    <div className="mt-3">
                      <label className="text-xs font-semibold uppercase tracking-wide text-faint" htmlFor={`mobile-live-${proposal.id}`}>
                        Type exactly: <span className="font-mono text-fg">{expectedLiveText}</span>
                      </label>
                      <input
                        id={`mobile-live-${proposal.id}`}
                        className="mt-1 min-h-11 w-full rounded-md border border-line bg-bg px-3 font-mono text-base text-fg outline-none focus:border-accent"
                        placeholder={expectedLiveText}
                        value={typedText}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        onPaste={(event) => event.preventDefault()}
                        onChange={(event) => setLiveTextByProposal((prev) => ({ ...prev, [proposal.id]: event.target.value }))}
                      />
                      <p className="mt-1 text-xs text-faint">
                        Paste is disabled; mobile approvals use the same broker check as console.
                      </p>
                    </div>
                  )}
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      className="min-h-11 rounded-md bg-emerald-500 px-3 text-sm font-semibold text-black disabled:opacity-50"
                      disabled={!commandAvailability.canSubmitAccountCommand || !livePhraseMatches || actionInFlight || actionSettled}
                      onClick={() =>
                        void submitCommand(
                          "proposal.approve",
                          {
                            proposalId: proposal.id,
                            ...(willPromptTyped
                              ? {
                                  liveConfirmation: {
                                    proposalId: proposal.id,
                                    accountNumber: proposal.accountNumber,
                                    executionMode: "broker/live",
                                    estimatedNotional: proposal.estimatedNotional ?? null,
                                    typedText: typedText.trim().toUpperCase()
                                  }
                                }
                              : {})
                          },
                          { key: `proposal.approve:${proposal.id}`, proposal: { id: proposal.id, action: "approve" } }
                        )
                      }
                    >
                      {feedback?.action === "approve" && actionInFlight ? (
                        <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="mr-1 inline h-4 w-4" />
                      )}
                      {feedback?.action === "approve" && actionInFlight ? "Approving…" : "Approve"}
                    </button>
                    <button
                      className="min-h-11 rounded-md border border-line bg-bg px-3 text-sm font-semibold text-fg disabled:opacity-50"
                      disabled={!commandAvailability.canSubmitAccountCommand || actionInFlight || actionSettled}
                      onClick={() =>
                        void submitCommand(
                          "proposal.reject",
                          { proposalId: proposal.id },
                          { key: `proposal.reject:${proposal.id}`, proposal: { id: proposal.id, action: "reject" } }
                        )
                      }
                    >
                      {feedback?.action === "reject" && actionInFlight ? (
                        <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />
                      ) : (
                        <X className="mr-1 inline h-4 w-4" />
                      )}
                      {feedback?.action === "reject" && actionInFlight ? "Rejecting…" : "Reject"}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Watchlist</h2>
          <div className="flex gap-2">
            <input
              className="min-h-11 min-w-0 flex-1 rounded-md border border-line bg-surface px-3 text-base text-fg outline-none focus:border-accent"
              autoCapitalize="characters"
              placeholder="Ticker"
              value={symbolInput}
              onChange={(event) => setSymbolInput(event.target.value)}
            />
            <button
              className="grid h-11 w-11 place-items-center rounded-md bg-accent text-accent-fg disabled:opacity-50"
              disabled={!commandAvailability.canSubmit || !symbolInput.trim()}
              onClick={() => {
                const submitted = symbolInput;
                void submitCommand("watchlist.add", { symbol: submitted }).then((accepted) => {
                  setSymbolInput((current) => nextDraftAfterCommandAcceptance(current, submitted, accepted, ""));
                });
              }}
              aria-label="Add ticker"
              title="Add ticker"
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {watchlist.length === 0 ? (
              <span className="text-sm text-faint">No tickers yet</span>
            ) : (
              watchlist.map((item) => (
                <button
                  key={item.symbol}
                  className="min-h-9 rounded-md border border-line bg-surface px-3 text-sm font-medium text-fg"
                  disabled={!commandAvailability.canSubmit}
                  onClick={() => void submitCommand("watchlist.remove", { symbol: item.symbol })}
                >
                  {item.symbol}
                </button>
              ))
            )}
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Price Alerts</h2>
          <div className="grid grid-cols-[minmax(0,1fr)_76px_minmax(0,1fr)_44px] gap-2">
            <input
              className="min-h-11 min-w-0 rounded-md border border-line bg-surface px-3 text-base text-fg outline-none focus:border-accent"
              placeholder="Ticker"
              value={alertInput.symbol}
              onChange={(event) => setAlertInput((prev) => ({ ...prev, symbol: event.target.value }))}
            />
            <select
              className="min-h-11 min-w-0 rounded-md border border-line bg-surface px-2 text-base text-fg outline-none focus:border-accent"
              value={alertInput.op}
              onChange={(event) => setAlertInput((prev) => ({ ...prev, op: event.target.value }))}
              aria-label="Alert direction"
            >
              <option value=">">Above</option>
              <option value="<">Below</option>
            </select>
            <input
              className="min-h-11 min-w-0 rounded-md border border-line bg-surface px-3 text-base text-fg outline-none focus:border-accent"
              inputMode="decimal"
              placeholder="Price"
              value={alertInput.price}
              onChange={(event) => setAlertInput((prev) => ({ ...prev, price: event.target.value }))}
            />
            <button
              className="grid h-11 w-11 place-items-center rounded-md bg-accent text-accent-fg disabled:opacity-50"
              disabled={!commandAvailability.canSubmit || !alertInput.symbol.trim() || !alertInput.price.trim()}
              onClick={() => {
                const submitted = alertInput;
                void submitCommand("alert.create", submitted).then((accepted) => {
                  setAlertInput((current) =>
                    nextDraftAfterCommandAcceptance(current, submitted, accepted, { symbol: "", op: ">", price: "" })
                  );
                });
              }}
              aria-label="Create alert"
              title="Create alert"
            >
              <Bell className="h-5 w-5" />
            </button>
          </div>
          <div className="space-y-2">
            {alerts.length === 0 ? (
              <Empty label="No alerts" />
            ) : (
              alerts.slice(0, 8).map((alert) => (
                <div key={alert.id} className="flex min-h-11 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm">
                  <span className="font-semibold">{alert.symbol}</span>
                  <span className="text-muted">
                    {alert.op} {money(alert.price)}
                  </span>
                  <span className="ml-auto capitalize text-faint">{alert.status}</span>
                  <button
                    className="grid h-8 w-8 place-items-center rounded-md text-muted"
                    disabled={!commandAvailability.canSubmit}
                    onClick={() => void submitCommand("alert.delete", { alertId: alert.id })}
                    aria-label={`Delete ${alert.symbol} alert`}
                    title="Delete alert"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Positions</h2>
            <span className="text-xs text-faint">{positions.length}</span>
          </div>
          {positions.length === 0 ? (
            <Empty label="No positions" />
          ) : (
            positions.slice(0, 10).map((position) => (
              <div key={position.symbol} className="flex min-h-11 items-center rounded-md border border-line bg-surface px-3 text-sm">
                <span className="font-semibold">{position.symbol}</span>
                <span className="ml-3 text-muted">{position.quantity} sh</span>
                <span className="ml-auto font-medium">{money(position.marketValue)}</span>
              </div>
            ))
          )}
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Command Log</h2>
          {(snapshot?.recentCommands ?? []).length === 0 ? (
            <Empty label="No mobile commands yet" />
          ) : (
            (snapshot?.recentCommands ?? []).slice(0, 8).map((command) => (
              <div key={command.id} className={`rounded-md border px-3 py-2 text-sm ${statusTone(command.status)}`}>
                <div className="flex items-center gap-2">
                  {command.status === "running" || command.status === "queued" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {command.status === "failed" ? <ShieldAlert className="h-4 w-4" /> : null}
                  {command.status === "succeeded" ? <Check className="h-4 w-4" /> : null}
                  {command.status === "cancelled" ? <CircleStop className="h-4 w-4" /> : null}
                  <span className="capitalize">{commandLabel(command.commandType)}</span>
                  <span className="ml-auto">{shortTime(command.updatedAt)}</span>
                </div>
                {command.error && <p className="mt-1 line-clamp-3 text-xs" title={command.error}>{command.error}</p>}
              </div>
            ))
          )}
        </section>

        {/* Collapsed by default so a destructive control doesn't sit on the main screen styled
            like the error/failed-command banners around it. Red styling only appears after an
            explicit tap to expand. */}
        <section className="border-t border-line pt-4">
          {!dangerZoneOpen ? (
            <button
            >
              Delete app account…
            </button>
          ) : (
            <div className="space-y-3 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-500/30 dark:bg-red-500/5">
              <div className="flex items-start gap-3">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-200" />
                <div>
                  <h2 className="text-sm font-semibold text-red-800 dark:text-red-100">Delete app account</h2>
                  <p className="mt-1 text-sm leading-relaxed text-red-700 dark:text-red-100/80">
                    This deletes the backend account tied to the current Google or Apple login. Broker and provider
                    secrets stored on the server are deleted. Signing in later with the same provider creates a fresh
                    app account with no prior trading data attached.
                  </p>
                </div>
              </div>

              {!deletionRequest ? (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm font-semibold text-fg"
                    onClick={() => setDangerZoneOpen(false)}
                  >
                    Keep account
                  </button>
                  <button
                    className="flex min-h-11 items-center justify-center gap-2 rounded-md border border-red-300 bg-red-100 px-3 text-sm font-semibold text-red-800 disabled:opacity-50 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100"
                    disabled={deleteBusy}
                    onClick={() => void startDeletion()}
                  >
                    <Trash2 className="h-4 w-4" />
                    Start deletion steps
                  </button>
                </div>
              ) : (
            <div className="space-y-3">
              <ol className="list-decimal space-y-1 pl-5 text-sm text-red-700 dark:text-red-100/80">
                {deletionRequest.steps.map((step, index) => (
                  <li key={`${index}-${step}`}>{step}</li>
                ))}
              </ol>
              <input
                className="min-h-11 w-full rounded-md border border-red-200 bg-bg px-3 text-base text-fg outline-none focus:border-red-400 dark:border-red-500/30 dark:focus:border-red-300"
                placeholder={deletionRequest.email ? "Type signed-in email" : "Type app user id"}
                value={deleteIdentity}
                onChange={(event) => setDeleteIdentity(event.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
              />
              <input
                className="min-h-11 w-full rounded-md border border-red-200 bg-bg px-3 text-base text-fg outline-none focus:border-red-400 dark:border-red-500/30 dark:focus:border-red-300"
                placeholder="Type required phrase"
                value={deletePhrase}
                onChange={(event) => setDeletePhrase(event.target.value)}
                autoCapitalize="characters"
                autoCorrect="off"
              />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm font-semibold text-fg"
                  onClick={() => {
                    setDeletionRequest(null);
                    setDeleteIdentity("");
                    setDeletePhrase("");
                    setDangerZoneOpen(false);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="flex min-h-11 items-center justify-center gap-2 rounded-md bg-red-600 px-3 text-sm font-semibold text-white disabled:opacity-50"
                  disabled={
                    deleteBusy ||
                    deleteIdentity.trim().toLowerCase() !== (deletionRequest.email ?? deletionRequest.userId).toLowerCase() ||
                    deletePhrase.trim() !== deletionRequest.requiredText
                  }
                  onClick={() => void confirmDeletion()}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete and sign out
                </button>
              </div>
              <p className="text-xs text-red-700/80 dark:text-red-100/70">
                This resets the backend account. OAuth access at Google or Apple is provider-side; revoke it in
                that account's security settings if you also want to remove this app from your provider account.
              </p>
                </div>
              )}
            </div>
          )}
        </section>

        <footer className="space-y-1 py-3 text-center text-xs text-faint">
          <div className="flex items-center justify-center gap-2">
            <Wifi className="h-3.5 w-3.5" />
            Backend is source of truth. No broker/provider secrets are stored on this device.
          </div>
          <p>
            Snapshot {snapshotFreshness === "fresh" ? `updated ${shortTime(lastSnapshotAt)}` : snapshotFreshness}
          </p>
        </footer>
      </div>
    </main>
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
