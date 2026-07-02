"use client";

/** Global chrome, rendered on every console screen:
 *  - word-first money-reality banner (TEST / PAPER / LIVE — words load-bearing)
 *  - account scope selector
 *  - run-state × authority chip in plain words
 *  - one-click STOP that never sells (honest copy about synthetic stops)
 *  - Run once (wired; disabled with a reason when blocked)
 *  - data freshness strip */

import { useMemo, useState } from "react";
import { ChevronDown, OctagonMinus, Play, ShieldCheck } from "lucide-react";
import type { DashboardSnapshot } from "../../dashboard-types";
import {
  activeConnectedAccount,
  deriveReality,
  deriveSpend,
  deriveStateInfo,
  realityForAccount
} from "../lib/derive";
import {
  activateAccount,
  ConsoleApiError,
  runOnce,
  setSystemState,
  startStrategy,
  stopEverything
} from "../lib/api";
import { cx, fmtClock, fmtMoney, fmtMoneyWhole, timeAgo, timeUntil, EM_DASH, fmtExact } from "../lib/format";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { Btn, Chip, Dot, Meter, TextInput } from "../ui/primitives";
import { Sheet } from "../ui/sheet";

// ── Reality banner ───────────────────────────────────────────────────────────

export function RealityBanner({ snapshot }: { snapshot: DashboardSnapshot }) {
  const reality = deriveReality(snapshot);
  return (
    <div className={cx("con-reality", `con-reality-${reality.tone}`)}>
      <div className="mx-auto flex max-w-[1400px] items-baseline gap-2 px-4 py-1.5">
        <span className="con-reality-word text-[length:var(--con-fs-sm)]">{reality.word}</span>
        <span className="font-semibold">· {reality.phrase}</span>
        <span className="hidden truncate text-[color:var(--con-muted)] sm:inline">— {reality.clarification}</span>
      </div>
    </div>
  );
}

// ── Account scope selector ───────────────────────────────────────────────────

function brokerName(broker: string | undefined): string {
  switch (broker) {
    case "alpaca":
    case "alpaca-mcp":
      return "Alpaca";
    case "robinhood":
      return "Robinhood";
    case "test":
      return "Simulator";
    default:
      return broker ?? "";
  }
}

export function ScopeSelector({ snapshot, compact }: { snapshot: DashboardSnapshot; compact?: boolean }) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const reality = deriveReality(snapshot);
  const active = activeConnectedAccount(snapshot);

  const label = active
    ? `${active.label || brokerName(active.broker)}${active.accountNumber ? ` ·· ${active.accountNumber.slice(-4)}` : ""}`
    : "Local simulator";

  const switchTo = async (id: string) => {
    setBusyId(id);
    try {
      await activateAccount(id);
      await refresh();
      toast.push("info", "Scope switched", "The whole console now shows this account.");
      setOpen(false);
    } catch (error) {
      toast.push("neg", "Could not switch accounts", error instanceof ConsoleApiError ? error.message : undefined);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-w-0 items-center gap-2 rounded-lg border border-[color:var(--con-line-strong)] bg-[color:var(--con-surface-2)] px-3 py-1.5 text-left transition-colors hover:border-[color:var(--con-accent)]"
        title="Switch which account this console shows"
      >
        <span className="min-w-0">
          <span className="block truncate text-[length:var(--con-fs-sm)] font-semibold leading-tight">{label}</span>
          {!compact && (
            <span className="block text-[length:var(--con-fs-xs)] leading-tight text-[color:var(--con-faint)]">
              {reality.word} · {reality.phrase}
            </span>
          )}
        </span>
        <ChevronDown size={14} className="shrink-0 text-[color:var(--con-faint)]" />
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Account scope">
        <p className="mb-3 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          Exactly one account is active at a time. Switching rescopes everything — balances, guardrails, approvals,
          the run state. Every row states its money-reality in words.
        </p>
        <div className="flex flex-col gap-2">
          {snapshot.connectedAccounts.length === 0 && (
            <div className="rounded-lg border border-[color:var(--con-line)] p-3 text-[length:var(--con-fs-sm)]">
              <div className="flex items-center gap-2">
                <span className="font-semibold">Local simulator</span>
                <Chip tone="test">TEST · practice money</Chip>
              </div>
              <p className="mt-1 text-[color:var(--con-muted)]">
                No brokerage is connected. The app trades simulated cash marked to live prices.
              </p>
            </div>
          )}
          {snapshot.connectedAccounts.map((account) => {
            const r = realityForAccount(account, snapshot.policy);
            return (
              <div
                key={account.id}
                className={cx(
                  "rounded-lg border p-3",
                  account.isActive ? "border-[color:var(--con-accent)]" : "border-[color:var(--con-line)]"
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-semibold">{account.label || brokerName(account.broker)}</span>
                    <Chip tone={r.tone}>
                      {r.word} · {r.phrase}
                    </Chip>
                    {account.isActive && <Chip tone="accent">active</Chip>}
                  </div>
                  {!account.isActive && (
                    <Btn size="sm" variant={r.tone === "live" ? "dangerOutline" : "outline"} disabled={busyId !== null} onClick={() => void switchTo(account.id)}>
                      {busyId === account.id ? "Switching…" : r.tone === "live" ? "Switch — real money" : "Switch"}
                    </Btn>
                  )}
                </div>
                <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  {brokerName(account.broker)} · {account.environment}
                  {account.accountNumber ? ` · ·· ${account.accountNumber.slice(-4)}` : ""} — {r.clarification}
                </p>
              </div>
            );
          })}
        </div>
      </Sheet>
    </>
  );
}

// ── Run-state chip + control sheet (STOP never sells) ────────────────────────

const STATE_TONE: Record<string, "pos" | "warn" | "neg" | "muted"> = {
  pos: "pos",
  warn: "warn",
  neg: "neg",
  muted: "muted"
};

export function StateChip({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [open, setOpen] = useState(false);
  const info = deriveStateInfo(snapshot.policy);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-lg border border-[color:var(--con-line-strong)] bg-[color:var(--con-surface-2)] px-3 py-1.5 transition-colors hover:border-[color:var(--con-accent)]"
        title={info.detail}
      >
        <Dot tone={STATE_TONE[info.tone]} pulse={info.state === "active" && snapshot.policy.strategyAuthority === "decide"} />
        <span className="whitespace-nowrap text-[length:var(--con-fs-sm)] font-semibold">{info.label}</span>
      </button>
      <ControlSheet snapshot={snapshot} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function StopButton({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="con-stop-btn"
        onClick={() => setOpen(true)}
        title="Stop the strategy. Stopping never sells anything."
      >
        <OctagonMinus size={15} />
        STOP
      </button>
      <ControlSheet snapshot={snapshot} open={open} onClose={() => setOpen(false)} emergency />
    </>
  );
}

/** One control surface for run-state changes. Asymmetric friction:
 *  stopping = one tap + one confirm, no typing; starting on real money =
 *  typed ritual; winding down (the one stop verb that SELLS) = typed ritual. */
function ControlSheet({
  snapshot,
  open,
  onClose,
  emergency
}: {
  snapshot: DashboardSnapshot;
  open: boolean;
  onClose: () => void;
  emergency?: boolean;
}) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [armText, setArmText] = useState("");
  const [confirmVerb, setConfirmVerb] = useState<"start" | "liquidate" | null>(null);
  const reality = deriveReality(snapshot);
  const info = deriveStateInfo(snapshot.policy);
  const state = snapshot.policy.systemState;

  const startPhrase = reality.tone === "live" ? "START LIVE" : null;
  const liquidatePhrase = "WIND DOWN";

  const act = async (verb: string, fn: () => Promise<unknown>, successTitle: string, successDetail?: string) => {
    setBusy(verb);
    try {
      await fn();
      await refresh();
      toast.push(verb === "stop" ? "warn" : "info", successTitle, successDetail);
      setConfirmVerb(null);
      setArmText("");
      onClose();
    } catch (error) {
      toast.push("neg", "That didn't go through", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const options = useMemo(
    () => [
      {
        id: "stop",
        title: "STOP everything",
        body:
          "Nothing buys, nothing sells — not even this app's automatic stop-losses, which pause too. Broker-held brackets keep resting at your broker. Your positions stay exactly as they are. Nothing is sold.",
        available: state !== "halted",
        danger: true
      },
      {
        id: "close_only",
        title: "Close-only",
        body:
          "No new buys. Protective sells and the app's stop monitor keep working. This is what the automatic circuit breakers choose.",
        available: state !== "close_only",
        danger: false
      },
      {
        id: "liquidating",
        title: "Wind down",
        body:
          "The strategy sells positions until the account is in cash. This SELLS things — it may realize losses and taxes.",
        available: state !== "liquidating",
        danger: true
      },
      {
        id: "start",
        title: state === "halted" ? "Start scheduled runs" : "Resume full operation",
        body:
          snapshot.policy.strategyAuthority === "decide"
            ? "Runs resume on schedule and the strategy may place orders itself, inside your guardrails."
            : "Runs resume on schedule. Every trade still waits for your approval.",
        available: state !== "active",
        danger: false
      }
    ],
    [state, snapshot.policy.strategyAuthority]
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={emergency ? "Stop the strategy" : "Run state"}
      tone={reality.tone === "live" ? "live" : undefined}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[length:var(--con-fs-sm)]">
        <Chip tone={reality.tone}>
          {reality.word} · {reality.phrase}
        </Chip>
        <span className="text-[color:var(--con-muted)]">
          Now: <strong className="text-[color:var(--con-fg)]">{info.label}</strong>
        </span>
      </div>
      <p className="mb-4 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">{info.detail}</p>

      <div className="flex flex-col gap-2.5">
        {options
          .filter((o) => o.available)
          .map((o) => (
            <div key={o.id} className="rounded-lg border border-[color:var(--con-line)] p-3">
              <div className="flex items-center justify-between gap-3">
                <span className={cx("font-semibold", o.id === "stop" && "text-[color:var(--con-neg)]")}>{o.title}</span>
                {o.id === "stop" && (
                  <Btn variant="danger" size="sm" disabled={busy !== null} onClick={() => void act("stop", stopEverything, "Stopped", "Nothing was sold. App-managed stops are paused; broker-held brackets keep resting.")}>
                    {busy === "stop" ? "Stopping…" : "Confirm: STOP"}
                  </Btn>
                )}
                {o.id === "close_only" && (
                  <Btn variant="outline" size="sm" disabled={busy !== null} onClick={() => void act("close_only", () => setSystemState("close_only"), "Close-only", "No new buys. Protective exits keep working.")}>
                    {busy === "close_only" ? "Switching…" : "Confirm"}
                  </Btn>
                )}
                {o.id === "liquidating" && (
                  <Btn variant="dangerOutline" size="sm" disabled={busy !== null} onClick={() => setConfirmVerb(confirmVerb === "liquidate" ? null : "liquidate")}>
                    Wind down…
                  </Btn>
                )}
                {o.id === "start" &&
                  (startPhrase ? (
                    <Btn variant="dangerOutline" size="sm" disabled={busy !== null} onClick={() => setConfirmVerb(confirmVerb === "start" ? null : "start")}>
                      Start…
                    </Btn>
                  ) : (
                    <Btn variant="pos" size="sm" disabled={busy !== null} onClick={() => void act("start", startStrategy, "Running", "Scheduled runs are on.")}>
                      {busy === "start" ? "Starting…" : "Start"}
                    </Btn>
                  ))}
              </div>
              <p className="mt-1.5 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">{o.body}</p>

              {o.id === "liquidating" && confirmVerb === "liquidate" && (
                <TypedConfirm
                  phrase={liquidatePhrase}
                  value={armText}
                  onChange={setArmText}
                  busy={busy === "liquidating"}
                  confirmLabel="Wind down — this sells"
                  variant="danger"
                  onConfirm={() =>
                    void act("liquidating", () => setSystemState("liquidating"), "Winding down", "Only sell orders until the account is in cash.")
                  }
                />
              )}
              {o.id === "start" && confirmVerb === "start" && startPhrase && (
                <TypedConfirm
                  phrase={startPhrase}
                  value={armText}
                  onChange={setArmText}
                  busy={busy === "start"}
                  confirmLabel="Start on real money"
                  variant="danger"
                  note="This is a LIVE account. Starting is the risk-increasing direction, so it costs a typed phrase — stopping never does."
                  onConfirm={() => void act("start", startStrategy, "Running", "Scheduled runs are on — on real money.")}
                />
              )}
            </div>
          ))}
      </div>
    </Sheet>
  );
}

export function TypedConfirm({
  phrase,
  value,
  onChange,
  onConfirm,
  busy,
  confirmLabel,
  variant = "danger",
  note
}: {
  phrase: string;
  value: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  busy?: boolean;
  confirmLabel: string;
  variant?: "danger" | "pos";
  note?: string;
}) {
  const matches = value.trim().toUpperCase() === phrase;
  return (
    <div className="mt-3 rounded-lg border border-[color:rgba(255,93,93,0.4)] bg-[color:var(--con-live-soft)] p-3">
      {note && <p className="mb-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{note}</p>}
      <label className="con-label">
        Type exactly: <span className="con-mono text-[color:var(--con-fg)]">{phrase}</span>
      </label>
      <div className="flex gap-2">
        <TextInput
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          onPaste={(e) => e.preventDefault()}
          placeholder={phrase}
          className="con-mono"
        />
        <Btn variant={variant} disabled={!matches || busy} onClick={onConfirm}>
          {busy ? "Working…" : confirmLabel}
        </Btn>
      </div>
    </div>
  );
}

// ── Run once ─────────────────────────────────────────────────────────────────

export function RunOnceButton({ snapshot, size }: { snapshot: DashboardSnapshot; size?: "sm" }) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [running, setRunning] = useState(false);

  const blockedReason =
    snapshot.llmConfigured === false
      ? "Add an LLM key first — proposal generation needs one."
      : snapshot.accountReadiness && !snapshot.accountReadiness.ok
        ? snapshot.accountReadiness.detail
        : null;

  const run = async () => {
    setRunning(true);
    try {
      const result = await runOnce();
      await refresh();
      if (result.status === "failed") {
        toast.push("neg", "Run failed", result.summary);
      } else {
        toast.push("pos", "Run complete", result.summary);
      }
    } catch (error) {
      toast.push("neg", "Run failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Btn
      variant="primary"
      size={size}
      disabled={running || blockedReason !== null}
      onClick={() => void run()}
      title={blockedReason ?? "Manual runs always ask first — they can only propose, never place on their own."}
    >
      <Play size={13} />
      {running ? "Running…" : "Run once"}
    </Btn>
  );
}

// ── Freshness strip ──────────────────────────────────────────────────────────

export function FreshnessStrip({ snapshot, fetchedAt, error }: { snapshot: DashboardSnapshot; fetchedAt: Date | null; error: string | null }) {
  const spend = deriveSpend(snapshot);
  const scanAt = snapshot.latestStrategyRun?.marketScan?.generatedAt;
  const nextRun = snapshot.scheduler?.nextRunAt;
  return (
    <div className="border-t border-[color:var(--con-line)] bg-[color:var(--con-surface)] text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5">
        <span title="When this console last fetched data. It refreshes about every 15 seconds.">
          Data as of {fetchedAt ? fmtClock(fetchedAt) : EM_DASH} · quotes may be delayed
        </span>
        {scanAt && <span title={fmtExact(scanAt)}>Scan {timeAgo(scanAt)}</span>}
        {snapshot.marketSession && <span>Market: {snapshot.marketSession}</span>}
        {nextRun && snapshot.policy.systemState === "active" && <span title={fmtExact(nextRun)}>Next run {timeUntil(nextRun)}</span>}
        <span className="con-num flex min-w-32 items-center gap-2" title="Opening orders only. Exits never consume the daily cap.">
          <ShieldCheck size={12} />
          Today: {fmtMoney(spend.usedNotional)}
          {typeof spend.capNotional === "number" ? ` of ${fmtMoneyWhole(spend.capNotional)}` : ""}
          <Meter value={spend.usedNotional} max={spend.capNotional} className="w-16" />
        </span>
        {error && (
          <span className="font-semibold text-[color:var(--con-warn)]" title={error}>
            refresh failing — showing last good data
          </span>
        )}
      </div>
    </div>
  );
}
