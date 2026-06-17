"use client";

import {
  Activity as ActivityIcon,
  AlertTriangle,
  BrainCircuit,
  Check,
  CheckCircle,
  ChevronRight,
  Command as CommandIcon,
  Gauge,
  Info,
  LayoutDashboard,
  LineChart as LineChartIcon,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Settings as SettingsIcon,
  Shield,
  Sparkles,
  TrendingUp,
  Wallet,
  X,
  XCircle,
  Zap
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_STRATEGY_PROMPT } from "@/lib/defaults";
import {
  cellTitle,
  companyTitle,
  enrichPositionsForDisplay,
  formatNotificationDisplay,
  formatShareQuantity,
  quoteTitle,
  ratingTitle,
  sentimentTitle
} from "@/lib/dashboard-ui";
import type { EnrichedPosition } from "@/lib/dashboard-ui";
import { SP500_SYMBOLS } from "@/lib/sp500";
import type {
  EquityPosition,
  MarketQuote,
  NotificationSettings,
  ScoringWeights,
  StrategyTuningProposal,
  TradingPolicy,
  TradeProposal
} from "@/lib/types";
import type { DashboardSnapshot, UnifiedActivityGroup } from "./dashboard-types";
import { compactMoney, compactNum, formatPct, money, signedMoney } from "./dashboard-widgets";
import { cn } from "./ui/cn";
import { AllocationDonut, EquityCurve, ScorecardBars } from "./ui/charts";
import { CommandPalette, type Command } from "./ui/command-palette";
import { ConfirmModal, Modal, SlideOver } from "./ui/overlays";
import {
  Button,
  Card,
  Chip,
  Dot,
  EmptyState,
  Field,
  IconButton,
  PanelHeader,
  Segmented,
  StatTile,
  Switch,
  Tabs,
  inputClass
} from "./ui/primitives";
import { ThemeToggle } from "./ui/theme";

type SortDir = "asc" | "desc";
type PolicyPatch = Partial<TradingPolicy> & { strategyPrompt?: string };
type WorkspaceTab = "decision" | "market" | "performance" | "strategy";
type FeedTab = "activity" | "runs" | "notifications";

export function DashboardClient({ initialSnapshot }: { initialSnapshot: DashboardSnapshot }) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(initialSnapshot);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [alertMessage, setAlertMessage] = useState<{ title: string; body: string; type: "error" | "warning" | "success" } | null>(null);

  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("decision");
  const [feedTab, setFeedTab] = useState<FeedTab>("activity");
  const [feedOpen, setFeedOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [killConfirm, setKillConfirm] = useState(false);

  const [newProfileName, setNewProfileName] = useState("");
  const [strategyTuning, setStrategyTuning] = useState<StrategyTuningProposal | null>(null);
  const [tuningBusy, setTuningBusy] = useState(false);
  const [tuningError, setTuningError] = useState("");
  const promptSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void load({ quiet: true });
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(""), 6000);
    return () => clearTimeout(timer);
  }, [result]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function load(options: { quiet?: boolean } = {}) {
    if (!options.quiet) setBusy(true);
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      if (!response.ok) throw new Error(await response.text());
      setSnapshot((await response.json()) as DashboardSnapshot);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Dashboard refresh failed.");
    } finally {
      if (!options.quiet) setBusy(false);
    }
  }

  async function updatePolicy(patch: PolicyPatch) {
    setBusy(true);
    try {
      const response = await fetch("/api/policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...snapshot.policy, ...patch })
      });
      if (!response.ok) throw new Error(await response.text());
      await load({ quiet: true });
      setError("");
    } catch (policyError) {
      setError(policyError instanceof Error ? policyError.message : "Policy update failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveStrategyPrompt(prompt: string) {
    await updatePolicy({ strategyPrompt: prompt });
  }

  function editStrategyPrompt(value: string) {
    setSnapshot((current) => ({ ...current, strategyPrompt: value }));
    if (promptSaveTimer.current) clearTimeout(promptSaveTimer.current);
    promptSaveTimer.current = setTimeout(() => saveStrategyPrompt(value), 800);
  }

  async function runStrategy() {
    setBusy(true);
    try {
      const response = await fetch("/api/strategy/run", { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      const body = (await response.json()) as { summary?: string };
      setResult(body.summary ?? "Strategy run completed.");
      await load({ quiet: true });
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Strategy run failed.");
    } finally {
      setBusy(false);
    }
  }

  async function approveProposal(proposalId: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/proposals/${proposalId}/approve`, { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      const body = (await response.json()) as { status: string; orderId?: string; reasons?: string[] };
      if (body.status === "blocked") {
        const reasonsMsg = body.reasons?.map((r) => `• ${r}`).join("\n") ?? "No reasons provided.";
        setAlertMessage({ title: "Proposal blocked by policy", body: `The following rules blocked this order:\n\n${reasonsMsg}`, type: "warning" });
      } else {
        setResult(
          body.status === "placed"
            ? `Order placed${body.orderId ? `: ${body.orderId}` : ""}.`
            : body.status === "paper"
              ? "Proposal executed in Paper mode."
              : `Result: ${body.status}`
        );
      }
      if (body.status === "placed" || body.status === "paper") await load({ quiet: true });
      setError("");
    } catch (approvalError) {
      const errMsg = approvalError instanceof Error ? approvalError.message : "Proposal approval failed.";
      setError(errMsg);
      setAlertMessage({ title: "Execution error", body: `Failed to approve proposal:\n${errMsg}`, type: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function rejectProposal(proposalId: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/proposals/${proposalId}/reject`, { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      setResult("Proposal rejected.");
      await load({ quiet: true });
    } catch (rejectError) {
      setError(rejectError instanceof Error ? rejectError.message : "Proposal rejection failed.");
    } finally {
      setBusy(false);
    }
  }

  async function activateProfile(profileId: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/profiles/${profileId}/activate`, { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      await load({ quiet: true });
    } catch (profileError) {
      setError(profileError instanceof Error ? profileError.message : "Profile activation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function createProfile() {
    const name = newProfileName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const response = await fetch("/api/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, policy: snapshot.policy, prompt: snapshot.strategyPrompt, active: true })
      });
      if (!response.ok) throw new Error(await response.text());
      setNewProfileName("");
      await load({ quiet: true });
    } catch (profileError) {
      setError(profileError instanceof Error ? profileError.message : "Profile creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function requestStrategyTuning() {
    setTuningBusy(true);
    setTuningError("");
    try {
      const response = await fetch("/api/strategy/tune", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "Strategy tuning review failed.");
      setStrategyTuning(body as StrategyTuningProposal);
    } catch (tuneError) {
      setTuningError(tuneError instanceof Error ? tuneError.message : "Strategy tuning review failed.");
    } finally {
      setTuningBusy(false);
    }
  }

  async function applyStrategyTuning() {
    if (!strategyTuning) return;
    const patch = strategyTuning.proposedPatch;
    await updatePolicy({
      ...(patch.policy ?? {}),
      ...(patch.scoringWeights ? { scoringWeights: { ...policy.scoringWeights, ...patch.scoringWeights } } : {}),
      ...(patch.policy?.riskRules ? { riskRules: { ...policy.riskRules, ...patch.policy.riskRules } } : {}),
      ...(patch.prompt ? { strategyPrompt: patch.prompt } : {})
    });
    setResult("Strategy tuning changes applied.");
  }

  const policy = snapshot.policy;
  const dailyStats = snapshot.dailyStats ?? { orderCount: 0, notional: 0 };
  const remainingNotional = Math.max(0, policy.maxDailyNotional - dailyStats.notional);
  const remainingOrders = Math.max(0, policy.maxDailyOrders - dailyStats.orderCount);
  const enableBlockedReason = !policy.accountNumber
    ? "Select an account before enabling autonomy."
    : policy.universe === "custom" && policy.allowlist.length === 0
      ? "Add at least one ticker to the allowlist before enabling autonomy."
      : undefined;
  const allowedCount = policy.universe === "sp500" ? SP500_SYMBOLS.length : policy.allowlist.length;
  const mode = policy.paperMode ? "paper" : "live";
  const symbolMetaBySymbol = snapshot.symbolMetaBySymbol ?? {};
  const dailyNotionalPct = policy.maxDailyNotional > 0 ? Math.round((dailyStats.notional / policy.maxDailyNotional) * 100) : 0;
  const pendingCount = snapshot.pendingProposals.length;

  const commands: Command[] = [
    { id: "run", label: "Run strategy once", hint: "R", icon: <Zap size={15} />, run: () => void runStrategy() },
    { id: "refresh", label: "Refresh data", icon: <RefreshCw size={15} />, run: () => void load() },
    { id: "decision", label: "Go to Decision", icon: <LayoutDashboard size={15} />, run: () => setWorkspaceTab("decision") },
    { id: "market", label: "Go to Market Scan", icon: <LineChartIcon size={15} />, run: () => setWorkspaceTab("market") },
    { id: "perf", label: "Go to Performance", icon: <TrendingUp size={15} />, run: () => setWorkspaceTab("performance") },
    { id: "strategy", label: "Go to Strategy", icon: <BrainCircuit size={15} />, run: () => setWorkspaceTab("strategy") },
    { id: "studio", label: "Open Strategy Studio", icon: <BrainCircuit size={15} />, run: () => setStudioOpen(true) },
    { id: "activity", label: "Open Activity feed", icon: <ActivityIcon size={15} />, run: () => setFeedOpen(true) },
    { id: "settings", label: "Open Settings", icon: <SettingsIcon size={15} />, run: () => setSettingsOpen(true) },
    { id: "mode", label: `Switch to ${policy.paperMode ? "Live" : "Paper"} mode`, icon: <Wallet size={15} />, run: () => void updatePolicy({ paperMode: !policy.paperMode }) },
    { id: "autonomy", label: policy.enabled ? "Pause autonomy" : "Enable autonomy", icon: policy.enabled ? <Pause size={15} /> : <Play size={15} />, run: () => updatePolicy({ enabled: !policy.enabled, killSwitch: false }) },
    { id: "kill", label: policy.killSwitch ? "Deactivate kill switch" : "Activate kill switch", icon: <Shield size={15} />, run: () => setKillConfirm(true) }
  ];

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* ── Command bar ─────────────────────────────────────────── */}
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-line bg-surface/70 px-4 backdrop-blur-md">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Zap size={17} className="fill-current" />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-fg">Agentic Cockpit</div>
            <div className="flex items-center gap-1.5 text-[11px] text-muted">
              <Dot tone={policy.killSwitch ? "down" : policy.enabled ? "up" : "warn"} pulse={policy.enabled && !policy.killSwitch} />
              {policy.killSwitch ? "Halted" : policy.enabled ? "Autonomy on" : "Paused"}
              <span className="text-faint">· {snapshot.marketSession ?? "—"}</span>
            </div>
          </div>
        </div>

        <div className="ml-2 hidden items-center gap-2 lg:flex">
          <StatusPill label="Portfolio" value={money(snapshot.portfolio?.totalMarketValue)} />
          <StatusPill label="Buying power" value={money(snapshot.portfolio?.buyingPower)} />
          <DailyRiskPill pct={dailyNotionalPct} used={dailyStats.notional} cap={policy.maxDailyNotional} />
          <StatusPill label="Universe" value={policy.universe === "sp500" ? "S&P 500" : `${allowedCount} tickers`} />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Segmented
            value={mode}
            onChange={(v) => updatePolicy({ paperMode: v === "paper" })}
            options={[
              { value: "paper", label: "Paper" },
              { value: "live", label: "Live", tone: "down" }
            ]}
          />
          <button
            onClick={() => setPaletteOpen(true)}
            className="hidden items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-muted transition-colors hover:text-fg md:flex"
          >
            <CommandIcon size={13} /> K
          </button>
          <IconButton label="Refresh" onClick={() => load()} disabled={busy}>
            <RefreshCw size={15} className={cn(busy && "animate-spin")} />
          </IconButton>
          <button
            onClick={() => setFeedOpen(true)}
            className="relative inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm font-medium text-fg transition-colors hover:bg-surface-2"
          >
            <ActivityIcon size={15} /> Activity
            {pendingCount > 0 && (
              <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warn px-1 text-[10px] font-bold text-black">
                {pendingCount}
              </span>
            )}
          </button>
          <Button variant="ghost" size="sm" className="h-9" onClick={() => setStudioOpen(true)}>
            <BrainCircuit size={15} /> Strategy
          </Button>
          <IconButton label="Settings" onClick={() => setSettingsOpen(true)}>
            <SettingsIcon size={15} />
          </IconButton>
          <ThemeToggle />
          <Button size="sm" className="h-9" onClick={runStrategy} disabled={busy}>
            <Zap size={15} /> Run
          </Button>
          <Button
            variant={policy.killSwitch ? "primary" : "danger"}
            size="sm"
            className="h-9"
            onClick={() => setKillConfirm(true)}
          >
            {policy.killSwitch ? <Play size={15} /> : <X size={15} />} Kill
          </Button>
        </div>
      </header>

      {/* ── Body grid ───────────────────────────────────────────── */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 xl:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="hidden min-h-0 xl:block">
          <PortfolioRail snapshot={snapshot} mode={mode} symbolMetaBySymbol={symbolMetaBySymbol} />
        </aside>

        <main className="flex min-h-0 flex-col gap-3">
          <div className="flex items-center justify-between">
            <Tabs
              value={workspaceTab}
              onChange={setWorkspaceTab}
              tabs={[
                { id: "decision", label: "Decision" },
                { id: "market", label: "Market Scan" },
                { id: "performance", label: "Performance" },
                { id: "strategy", label: "Strategy" }
              ]}
            />
            {workspaceTab === "decision" && pendingCount > 0 && (
              <Chip tone="warn">
                {pendingCount} pending approval{pendingCount === 1 ? "" : "s"}
              </Chip>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {workspaceTab === "decision" && (
              <DecisionView
                snapshot={snapshot}
                symbolMetaBySymbol={symbolMetaBySymbol}
                busy={busy}
                approve={approveProposal}
                reject={rejectProposal}
              />
            )}
            {workspaceTab === "market" && <MarketScanView snapshot={snapshot} />}
            {workspaceTab === "performance" && <PerformanceView snapshot={snapshot} mode={mode} symbolMetaBySymbol={symbolMetaBySymbol} />}
            {workspaceTab === "strategy" && (
              <StrategyView
                snapshot={snapshot}
                policy={policy}
                onEdit={() => setStudioOpen(true)}
                activateProfile={activateProfile}
                newProfileName={newProfileName}
                setNewProfileName={setNewProfileName}
                createProfile={createProfile}
                requestStrategyTuning={requestStrategyTuning}
                tuningBusy={tuningBusy}
                tuningError={tuningError}
                strategyTuning={strategyTuning}
                applyStrategyTuning={applyStrategyTuning}
              />
            )}
          </div>
        </main>
      </div>

      {/* ── Toasts ──────────────────────────────────────────────── */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[1200] grid w-[min(420px,calc(100vw-2rem))] gap-2">
        {error && <Toast tone="error" message={error} onClose={() => setError("")} />}
        {result && <Toast tone="info" message={result} onClose={() => setResult("")} />}
      </div>

      {/* ── Overlays ────────────────────────────────────────────── */}
      <SlideOver
        open={feedOpen}
        onClose={() => setFeedOpen(false)}
        title="Activity"
        subtitle="Trading log, runs & notifications"
        icon={<ActivityIcon size={18} />}
        width="max-w-2xl"
      >
        <div className="p-4">
          <Tabs
            value={feedTab}
            onChange={setFeedTab}
            tabs={[
              { id: "activity", label: "Activity" },
              { id: "runs", label: "Runs" },
              { id: "notifications", label: "Notifications" }
            ]}
          />
        </div>
        <div className="px-4 pb-4">
          {feedTab === "activity" && <ActivityFeed snapshot={snapshot} />}
          {feedTab === "runs" && <RunHistory snapshot={snapshot} />}
          {feedTab === "notifications" && <NotificationsList snapshot={snapshot} />}
        </div>
      </SlideOver>

      <Modal open={studioOpen} onClose={() => setStudioOpen(false)} title="Strategy Studio" subtitle="Prompt, sliders, scoring weights & LLM review" icon={<BrainCircuit size={18} />} size="xl">
        <StrategyStudio
          snapshot={snapshot}
          policy={policy}
          editStrategyPrompt={editStrategyPrompt}
          resetPrompt={() => {
            setSnapshot((c) => ({ ...c, strategyPrompt: DEFAULT_STRATEGY_PROMPT }));
            void saveStrategyPrompt(DEFAULT_STRATEGY_PROMPT);
          }}
          updatePolicy={updatePolicy}
          requestStrategyTuning={requestStrategyTuning}
          tuningBusy={tuningBusy}
          tuningError={tuningError}
          strategyTuning={strategyTuning}
          applyStrategyTuning={applyStrategyTuning}
        />
      </Modal>

      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Settings" subtitle="Account, risk & notifications" icon={<SettingsIcon size={18} />} size="lg">
        <SettingsContent
          snapshot={snapshot}
          policy={policy}
          allowedCount={allowedCount}
          enableBlockedReason={enableBlockedReason}
          remainingNotional={remainingNotional}
          remainingOrders={remainingOrders}
          updatePolicy={updatePolicy}
        />
      </Modal>

      <ConfirmModal
        open={killConfirm}
        onClose={() => setKillConfirm(false)}
        onConfirm={async () => {
          await updatePolicy({ killSwitch: !policy.killSwitch });
          setKillConfirm(false);
        }}
        title={policy.killSwitch ? "Deactivate kill switch?" : "Activate kill switch?"}
        body={
          policy.killSwitch
            ? "This resumes automated trading operations."
            : "This immediately pauses all automated trading runs and blocks any new order proposals."
        }
        confirmLabel="Confirm"
        tone={policy.killSwitch ? "primary" : "danger"}
      />

      <Modal open={!!alertMessage} onClose={() => setAlertMessage(null)} title={alertMessage?.title ?? ""} size="sm" footer={<Button onClick={() => setAlertMessage(null)}>Dismiss</Button>}>
        {alertMessage?.body.split("\n").map((line, i) => (
          <p key={i} className="text-sm leading-relaxed text-muted">
            {line || " "}
          </p>
        ))}
      </Modal>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
  );
}

/* ───────────────────────── Command-bar pieces ───────────────────────── */

function StatusPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col rounded-lg border border-line bg-surface px-3 py-1">
      <span className="text-[9px] font-semibold uppercase tracking-wide text-faint">{label}</span>
      <span className="tnum text-[13px] leading-tight text-fg">{value}</span>
    </div>
  );
}

function DailyRiskPill({ pct, used, cap }: { pct: number; used: number; cap: number }) {
  const tone = pct >= 90 ? "down" : pct >= 60 ? "warn" : "accent";
  const bar = tone === "down" ? "bg-down" : tone === "warn" ? "bg-warn" : "bg-accent";
  return (
    <div className="flex flex-col rounded-lg border border-line bg-surface px-3 py-1" title={`${money(used)} of ${money(cap)} daily notional used`}>
      <span className="text-[9px] font-semibold uppercase tracking-wide text-faint">Daily risk</span>
      <div className="flex items-center gap-1.5">
        <span className="tnum text-[13px] leading-tight text-fg">{pct}%</span>
        <span className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-3">
          <span className={cn("block h-full rounded-full", bar)} style={{ width: `${Math.min(100, pct)}%` }} />
        </span>
      </div>
    </div>
  );
}

function Toast({ tone, message, onClose }: { tone: "error" | "info"; message: string; onClose: () => void }) {
  return (
    <div
      className={cn(
        "pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-surface p-3 shadow-[var(--shadow)]",
        tone === "error" ? "border-l-4 border-l-down border-line" : "border-l-4 border-l-info border-line"
      )}
    >
      {tone === "error" ? <AlertTriangle size={16} className="mt-0.5 text-down" /> : <Info size={16} className="mt-0.5 text-info" />}
      <span className="flex-1 text-[13px] leading-snug text-fg">{message}</span>
      <button onClick={onClose} aria-label="Dismiss" className="text-faint hover:text-fg">
        <X size={14} />
      </button>
    </div>
  );
}

/* ───────────────────────── Portfolio rail ───────────────────────── */

function PortfolioRail({
  snapshot,
  mode,
  symbolMetaBySymbol
}: {
  snapshot: DashboardSnapshot;
  mode: "paper" | "live";
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
}) {
  const portfolio = snapshot.portfolio;
  const positions = snapshot.positions;
  const total = portfolio?.totalMarketValue ?? 0;
  const perf = snapshot.performance;
  const dayPnl = mode === "paper" ? (perf?.paperUnrealizedPnl ?? 0) + (perf?.paperRealizedPnl ?? 0) : (perf?.liveUnrealizedPnl ?? 0) + (perf?.liveRealizedPnl ?? 0);

  const equityValue = positions.reduce((s, p) => s + p.marketValue, 0);
  const cashValue = Math.max(0, total - equityValue);
  const segments = [
    ...positions.map((p) => ({ label: p.symbol, value: p.marketValue, pct: total > 0 ? (p.marketValue / total) * 100 : 0 })),
    { label: "Cash", value: cashValue, pct: total > 0 ? (cashValue / total) * 100 : 0 }
  ].filter((s) => s.pct > 0.05);

  const enriched = enrichPositionsForDisplay(positions, total).sort((a, b) => b.marketValue - a.marketValue);

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <PanelHeader title="Portfolio" subtitle={mode === "paper" ? "Paper account" : "Live account"} icon={<Wallet size={16} />} />
      <div className="grid grid-cols-2 gap-2 px-4 pt-3">
        <StatTile label="Value" value={money(total)} />
        <StatTile label="P&L" value={signedMoney(dayPnl)} tone={dayPnl >= 0 ? "up" : "down"} />
      </div>
      <div className="px-4 py-3">
        {segments.length > 0 ? <AllocationDonut segments={segments} /> : <EmptyState title="No allocation yet" />}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {enriched.length === 0 ? (
          <EmptyState icon={<Wallet size={18} />} title="No open positions" hint="Run the strategy to start building a position set." />
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface">
              <tr className="text-[11px] uppercase text-faint">
                <th className="px-2 py-1.5 text-left font-semibold">Symbol</th>
                <th className="px-2 py-1.5 text-right font-semibold">Value</th>
                <th className="px-2 py-1.5 text-right font-semibold">P&L</th>
              </tr>
            </thead>
            <tbody>
              {enriched.map((p) => (
                <tr key={p.symbol} className="border-t border-line/60 hover:bg-surface-2">
                  <td className="px-2 py-1.5">
                    <div className="font-semibold text-fg" title={companyTitle(p.symbol, symbolMetaBySymbol)}>{p.symbol}</div>
                    <div className="tnum text-[11px] text-faint">{formatShareQuantity(p.quantity, p.symbol)} sh · {p.allocPct.toFixed(1)}%</div>
                  </td>
                  <td className="px-2 py-1.5 text-right tnum text-fg">{money(p.marketValue)}</td>
                  <td className={cn("px-2 py-1.5 text-right tnum", p.pnl >= 0 ? "text-up" : "text-down")}>
                    <div>{signedMoney(p.pnl)}</div>
                    <div className="text-[11px]">{formatPct(p.returnPct)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}

/* ───────────────────────── Decision view ───────────────────────── */

function DecisionView({
  snapshot,
  symbolMetaBySymbol,
  busy,
  approve,
  reject
}: {
  snapshot: DashboardSnapshot;
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
  busy: boolean;
  approve: (id: string) => void;
  reject: (id: string) => void;
}) {
  const decision = snapshot.latestStrategyRun;
  const pending = snapshot.pendingProposals;
  return (
    <div className="space-y-3">
      {pending.length > 0 && (
        <Card className="overflow-hidden">
          <PanelHeader title="Pending approval" subtitle="Review and approve or reject" icon={<CheckCircle size={16} />} />
          <div className="grid gap-2 p-4 pt-3 sm:grid-cols-2">
            {pending.map((p) => (
              <div key={p.id} className="rounded-xl border border-line bg-surface-2 p-3">
                <div className="flex items-center gap-2">
                  <Chip tone={p.proposal.side === "buy" ? "up" : "down"}>{p.proposal.side.toUpperCase()}</Chip>
                  <span className="text-base font-semibold text-fg" title={companyTitle(p.proposal.symbol, symbolMetaBySymbol)}>{p.proposal.symbol}</span>
                  <span className="ml-auto tnum text-xs text-muted">{proposalSize(p.proposal)}</span>
                </div>
                <p className="mt-2 line-clamp-3 text-[13px] leading-snug text-muted">{p.proposal.rationale}</p>
                <div className="mt-3 flex gap-2">
                  <Button variant="primary" size="sm" className="flex-1" disabled={busy} onClick={() => approve(p.id)}>
                    <Check size={14} /> Approve
                  </Button>
                  <Button variant="ghost" size="sm" className="flex-1" disabled={busy} onClick={() => reject(p.id)}>
                    <XCircle size={14} /> Reject
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="overflow-hidden">
        <PanelHeader
          title="Latest decision"
          subtitle={decision?.marketScan ? `${decision.marketScan.scannedSymbols} symbols scanned · ${formatSources(decision.marketScan.source)}` : "Run the strategy to generate a decision"}
          icon={<Sparkles size={16} />}
        />
        {!decision ? (
          <EmptyState icon={<BrainCircuit size={20} />} title="No decision yet" hint="Hit Run (or ⌘K → Run strategy once) to generate the agent's first decision." />
        ) : (
          <div className="space-y-3 p-4 pt-3">
            <div className={cn("rounded-xl border px-3 py-2 text-[13px]", decision.status === "failed" ? "border-down/30 bg-down/10 text-down" : "border-info/25 bg-info/10 text-fg")}>
              {decision.summary}
            </div>
            {decision.proposals.map((item, i) => (
              <div key={`${item.proposal.symbol}-${i}`} className="rounded-xl border border-line bg-surface-2 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={statusTone(item.status)}>{displayStatus(item.status)}</Chip>
                  <Chip tone={item.proposal.side === "buy" ? "up" : "down"}>{item.proposal.side.toUpperCase()}</Chip>
                  <span className="font-semibold text-fg">{item.proposal.symbol}</span>
                  <span className="tnum text-xs text-muted">{proposalSize(item.proposal)} · {item.proposal.type}</span>
                  {item.proposal.tradeThesisTag && <Chip tone="accent">{item.proposal.tradeThesisTag}</Chip>}
                </div>
                <p className="mt-2 text-[13px] leading-snug text-muted">{item.proposal.rationale}</p>
                {item.reasons.length > 0 && <p className="mt-1.5 rounded bg-surface-3 px-2 py-1 text-[11px] text-faint">{item.reasons.join("; ")}</p>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ───────────────────────── Market scan view ───────────────────────── */

const SCAN_COLUMNS: Array<{ key: keyof MarketQuote; label: string; title: string; align?: "right" }> = [
  { key: "symbol", label: "Symbol", title: "Ticker" },
  { key: "price", label: "Price", title: "Last price", align: "right" },
  { key: "intradayChangePct", label: "Chg", title: "Intraday change %", align: "right" },
  { key: "volume", label: "Vol", title: "Volume", align: "right" },
  { key: "marketCap", label: "Mkt Cap", title: "Market cap", align: "right" },
  { key: "peRatio", label: "P/E", title: "Price/earnings", align: "right" },
  { key: "dividendYield", label: "Div", title: "Dividend yield", align: "right" },
  { key: "sentiment", label: "Sentiment", title: "News sentiment" },
  { key: "analystScore", label: "Rating", title: "Analyst consensus" },
  { key: "sector", label: "Sector", title: "Sector" },
  { key: "score", label: "Score", title: "Composite score", align: "right" }
];

function MarketScanView({ snapshot }: { snapshot: DashboardSnapshot }) {
  const scan = snapshot.latestStrategyRun?.marketScan;
  const [sort, setSort] = useState<{ col: keyof MarketQuote; dir: SortDir }>({ col: "score", dir: "desc" });
  if (!scan) {
    return (
      <Card>
        <PanelHeader title="Market scan" icon={<LineChartIcon size={16} />} />
        <EmptyState icon={<LineChartIcon size={20} />} title="No market scan captured yet" hint="Run the strategy once to populate the scored candidate set." />
      </Card>
    );
  }
  const sorted = [...scan.topCandidates].sort((a, b) => compare(a[sort.col], b[sort.col], sort.dir));
  return (
    <Card className="overflow-hidden">
      <PanelHeader
        title="Market scan"
        subtitle={`${scan.returnedQuotes} quotes · ${formatSources(scan.source)}${scan.cached ? " · cached" : ""}`}
        icon={<LineChartIcon size={16} />}
        actions={<Chip tone="neutral">{new Date(scan.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</Chip>}
      />
      <div className="overflow-x-auto p-2">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase text-faint">
              {SCAN_COLUMNS.map((c) => (
                <th
                  key={c.key as string}
                  title={c.title}
                  onClick={() => setSort((s) => ({ col: c.key, dir: s.col === c.key && s.dir === "desc" ? "asc" : "desc" }))}
                  className={cn("cursor-pointer select-none whitespace-nowrap px-2.5 py-2 font-semibold hover:text-fg", c.align === "right" ? "text-right" : "text-left")}
                >
                  {c.label}
                  <span className="ml-0.5 text-faint">{sort.col === c.key ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 20).map((q) => {
              const peText = q.peRatio && q.peRatio > 0 ? q.peRatio.toFixed(1) : typeof q.eps === "number" && q.eps <= 0 ? "n/a" : "—";
              return (
                <tr key={q.symbol} className="border-b border-line/50 hover:bg-surface-2">
                  <td className="px-2.5 py-1.5 font-semibold text-fg" title={q.companyName}>{q.symbol}</td>
                  <td className="px-2.5 py-1.5 text-right tnum" title={quoteTitle("Quote", q)}>{money(q.price)}</td>
                  <td className={cn("px-2.5 py-1.5 text-right tnum", q.intradayChangePct >= 0 ? "text-up" : "text-down")}>{formatPct(q.intradayChangePct)}</td>
                  <td className="px-2.5 py-1.5 text-right tnum text-muted">{q.volume > 0 ? compactNum(q.volume) : "—"}</td>
                  <td className="px-2.5 py-1.5 text-right tnum text-muted">{q.marketCap && q.marketCap > 0 ? compactMoney(q.marketCap) : "—"}</td>
                  <td className="px-2.5 py-1.5 text-right tnum text-muted" title={cellTitle("P/E", q.sources?.peRatio)}>{peText}</td>
                  <td className="px-2.5 py-1.5 text-right tnum text-muted">{typeof q.dividendYield === "number" ? `${q.dividendYield.toFixed(2)}%` : "—"}</td>
                  <td className="px-2.5 py-1.5" title={sentimentTitle(q)}>{typeof q.sentiment === "number" ? <SentimentChip value={q.sentiment} /> : <span className="text-faint">—</span>}</td>
                  <td className="px-2.5 py-1.5 text-muted" title={ratingTitle(q)}>{q.analystRating ? `${q.analystScore ?? ""} ${q.analystRating}`.trim() : "—"}</td>
                  <td className="px-2.5 py-1.5">{q.sector ? <Chip tone="info">{q.sector}</Chip> : <span className="text-faint">—</span>}</td>
                  <td className="px-2.5 py-1.5 text-right tnum font-semibold text-fg">{q.score.toFixed(1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function SentimentChip({ value }: { value: number }) {
  const tone = value >= 60 ? "up" : value <= 40 ? "down" : "neutral";
  const label = value >= 60 ? "Positive" : value <= 40 ? "Negative" : "Neutral";
  return <Chip tone={tone}>{label} {value}</Chip>;
}

/* ───────────────────────── Performance view ───────────────────────── */

function PerformanceView({
  snapshot,
  mode,
  symbolMetaBySymbol
}: {
  snapshot: DashboardSnapshot;
  mode: "paper" | "live";
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
}) {
  const perf = snapshot.performance;
  const curve = mode === "paper" ? perf?.paperEquityCurve ?? [] : perf?.liveEquityCurve ?? [];
  const realized = mode === "paper" ? perf?.paperRealizedPnl ?? 0 : perf?.liveRealizedPnl ?? 0;
  const unrealized = mode === "paper" ? perf?.paperUnrealizedPnl ?? 0 : perf?.liveUnrealizedPnl ?? 0;
  const winRate = mode === "paper" ? perf?.paperWinRate ?? 0 : perf?.liveWinRate ?? 0;
  const avgReturn = mode === "paper" ? perf?.paperAverageReturnPct ?? 0 : perf?.liveAverageReturnPct ?? 0;
  const thesis = (snapshot.thesisScorecard ?? []).map((t) => ({ label: t.thesisTag, pnl: t.totalPnl, winRate: t.winRate, trades: t.trades }));
  const regime = (snapshot.regimeScorecard ?? []).map((r) => ({ label: r.regime, pnl: r.totalPnl, winRate: r.winRate, trades: r.trades }));

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <PanelHeader title="Equity curve" subtitle={mode === "paper" ? "Paper account" : "Live account"} icon={<TrendingUp size={16} />} />
        <div className="grid grid-cols-2 gap-2 px-4 pt-3 sm:grid-cols-4">
          <StatTile label="Realized" value={signedMoney(realized)} tone={realized >= 0 ? "up" : "down"} />
          <StatTile label="Unrealized" value={signedMoney(unrealized)} tone={unrealized >= 0 ? "up" : "down"} />
          <StatTile label="Win rate" value={`${winRate.toFixed(0)}%`} />
          <StatTile label="Avg return" value={`${avgReturn.toFixed(2)}%`} tone={avgReturn >= 0 ? "up" : "down"} />
        </div>
        <div className="h-64 p-4">
          <EquityCurve data={curve} />
        </div>
      </Card>

      <Card>
        <PanelHeader title="What's working — by thesis" subtitle="Realized P&L grouped by trade thesis (the learning loop)" icon={<BrainCircuit size={16} />} />
        <div className="p-4 pt-3">
          <ScorecardBars data={thesis} />
        </div>
      </Card>

      <Card>
        <PanelHeader title="By market regime" subtitle="Realized P&L grouped by entry regime" icon={<Gauge size={16} />} />
        <div className="p-4 pt-3">
          <ScorecardBars data={regime} />
        </div>
      </Card>
    </div>
  );
}

/* ───────────────────────── Strategy view (tab) ───────────────────────── */

function StrategyView({
  snapshot,
  policy,
  onEdit,
  activateProfile,
  newProfileName,
  setNewProfileName,
  createProfile,
  requestStrategyTuning,
  tuningBusy,
  tuningError,
  strategyTuning,
  applyStrategyTuning
}: {
  snapshot: DashboardSnapshot;
  policy: TradingPolicy;
  onEdit: () => void;
  activateProfile: (id: string) => void;
  newProfileName: string;
  setNewProfileName: (v: string) => void;
  createProfile: () => void;
  requestStrategyTuning: () => void;
  tuningBusy: boolean;
  tuningError: string;
  strategyTuning: StrategyTuningProposal | null;
  applyStrategyTuning: () => void;
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <PanelHeader
          title="Active strategy"
          subtitle={policy.strategyAuthority === "decide" ? "LLM decides autonomously" : "LLM proposes, you approve"}
          icon={<BrainCircuit size={16} />}
          actions={<Button size="sm" variant="ghost" onClick={onEdit}><SettingsIcon size={14} /> Edit in Studio</Button>}
        />
        <div className="grid gap-3 p-4 pt-3 sm:grid-cols-2">
          <div>
            <span className="mb-1.5 block text-xs font-medium text-muted">Saved strategy</span>
            <select className={inputClass} value={snapshot.activeProfile?.id ?? ""} onChange={(e) => activateProfile(e.target.value)}>
              {snapshot.profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            <span className="mb-1.5 block text-xs font-medium text-muted">Save current as a named strategy</span>
            <div className="flex items-center gap-2">
              <input
                className={inputClass}
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                placeholder="Name this strategy"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    createProfile();
                  }
                }}
              />
              <Button onClick={createProfile} disabled={!newProfileName.trim()}>Save</Button>
              <span className="text-xs text-faint">Optional</span>
            </div>
          </div>
        </div>
        <div className="px-4 pb-4">
          <span className="mb-1.5 block text-xs font-medium text-muted">Prompt</span>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-bg/60 p-3 text-[13px] leading-relaxed text-muted">
            {snapshot.strategyPrompt}
          </pre>
        </div>
      </Card>

      <Card>
        <PanelHeader title="Key parameters" icon={<Shield size={16} />} />
        <div className="grid grid-cols-2 gap-2 p-4 pt-3 text-sm">
          <KeyVal label="Max order" value={money(policy.maxOrderNotional)} />
          <KeyVal label="Daily cap" value={money(policy.maxDailyNotional)} />
          <KeyVal label="Symbol cap" value={`${policy.maxSymbolExposurePct}%`} />
          <KeyVal label="Proposals/run" value={String(policy.maxProposalsPerRun)} />
          <KeyVal label="Stop loss" value={`${policy.riskRules.stopLossPct ?? 0}%`} />
          <KeyVal label="Take profit" value={`${policy.riskRules.takeProfitPct ?? 0}%`} />
        </div>
      </Card>

      <Card>
        <PanelHeader title="LLM strategy review" subtitle="Advisory — review past performance & suggest tuning" icon={<Sparkles size={16} />} actions={<Button size="sm" onClick={requestStrategyTuning} disabled={tuningBusy}><Zap size={14} /> {tuningBusy ? "Reviewing…" : "Review"}</Button>} />
        <div className="p-4 pt-3">
          {tuningError && <p className="mb-2 rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-[13px] text-down">{tuningError}</p>}
          {strategyTuning ? <TuningCard proposal={strategyTuning} onApply={applyStrategyTuning} /> : <p className="text-[13px] text-faint">No review yet. Run a review to get suggested prompt, scoring, and risk changes (you apply them manually).</p>}
        </div>
      </Card>
    </div>
  );
}

function KeyVal({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
      <div className="text-[11px] uppercase text-faint">{label}</div>
      <div className="tnum text-sm text-fg">{value}</div>
    </div>
  );
}

function TuningCard({ proposal, onApply }: { proposal: StrategyTuningProposal; onApply: () => void }) {
  const items = summarizeTuningPatch(proposal);
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <Chip tone={proposal.generatedBy === "llm" ? "accent" : "warn"}>{proposal.generatedBy === "llm" ? "LLM review" : "Local rules"}</Chip>
        <span className="text-xs text-faint">Confidence {proposal.confidenceScore.toFixed(0)}%</span>
      </div>
      <p className="text-sm font-medium text-fg">{proposal.summary}</p>
      <p className="text-[13px] text-muted">{proposal.rationale}</p>
      {items.length > 0 ? (
        <ul className="space-y-1 rounded-lg border border-line bg-surface-2 p-3 text-[13px] text-muted">
          {items.map((i) => (
            <li key={i} className="flex gap-2"><ChevronRight size={14} className="mt-0.5 shrink-0 text-accent" />{i}</li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-faint">No concrete patch fields returned.</p>
      )}
      {proposal.cautions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {proposal.cautions.map((c) => <Chip key={c} tone="warn">{c}</Chip>)}
        </div>
      )}
      <Button variant="primary" disabled={items.length === 0} onClick={onApply}><CheckCircle size={15} /> Apply reviewed changes</Button>
    </div>
  );
}

/* ───────────────────────── Feeds (slide-over) ───────────────────────── */

function ActivityFeed({ snapshot }: { snapshot: DashboardSnapshot }) {
  const feed = snapshot.unifiedFeed ?? [];
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (feed.length === 0) return <EmptyState icon={<ActivityIcon size={18} />} title="No activity yet" />;
  return (
    <div className="space-y-2">
      {feed.slice(0, 50).map((group) => {
        const accent = group.tags.includes("policy change")
          ? "border-l-info"
          : group.status === "filled"
            ? "border-l-up"
            : group.status === "blocked" || group.status === "rejected"
              ? "border-l-down"
              : group.status === "pending_approval" || group.status === "pending"
                ? "border-l-warn"
                : "border-l-line";
        const hasSub = group.events && group.events.length > 1;
        const open = !!expanded[group.id];
        return (
          <div key={group.id} className={cn("rounded-r-lg border-l-[3px] border-b border-line bg-surface-2/40 pl-3", accent)}>
            <div className="flex items-start justify-between gap-2 py-2 pr-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-faint">
                  <span>{new Date(group.updatedAt).toLocaleString()}</span>
                  {group.companyName && <span>({group.companyName})</span>}
                </div>
                <div className="mt-0.5 text-sm">{renderActionTitle(group.title)}</div>
                <div className="mt-0.5 text-[13px] text-muted">{group.detail}</div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {group.tags.map((t) => (
                    <span key={t} className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-faint">{t}</span>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <Chip tone={statusTone(group.status)}>{group.status.replace(/_/g, " ")}</Chip>
                {hasSub && (
                  <button onClick={() => setExpanded((e) => ({ ...e, [group.id]: !e[group.id] }))} className="text-[11px] text-muted hover:text-fg">
                    {open ? "Hide" : `+${group.events.length}`}
                  </button>
                )}
              </div>
            </div>
            {open && hasSub && (
              <div className="space-y-1 border-t border-dashed border-line py-2 pr-2">
                {group.events.map((ev) => (
                  <div key={ev.id} className="flex gap-2 text-[12px]">
                    <span className="w-24 shrink-0 text-faint">{new Date(ev.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                    <div className="flex-1">
                      <div>{renderActionTitle(ev.title)}</div>
                      <div className="text-[11px] text-faint">{ev.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RunHistory({ snapshot }: { snapshot: DashboardSnapshot }) {
  const runs = snapshot.strategyRuns ?? [];
  if (runs.length === 0) return <EmptyState icon={<Zap size={18} />} title="No strategy runs yet" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line text-[11px] uppercase text-faint">
            <th className="px-2 py-1.5 text-left font-semibold">Time</th>
            <th className="px-2 py-1.5 text-left font-semibold">Status</th>
            <th className="px-2 py-1.5 text-right font-semibold">Placed</th>
            <th className="px-2 py-1.5 text-right font-semibold">Paper</th>
            <th className="px-2 py-1.5 text-right font-semibold">Blocked</th>
            <th className="px-2 py-1.5 text-left font-semibold">Summary</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} className="border-b border-line/50">
              <td className="whitespace-nowrap px-2 py-1.5 text-muted">{new Date(run.startedAt).toLocaleString()}</td>
              <td className="px-2 py-1.5"><Chip tone={run.status === "completed" ? "up" : run.status === "failed" ? "down" : "warn"}>{run.status}</Chip></td>
              <td className="px-2 py-1.5 text-right tnum">{run.placedCount}</td>
              <td className="px-2 py-1.5 text-right tnum">{run.paperCount}</td>
              <td className="px-2 py-1.5 text-right tnum">{run.blockedCount}</td>
              <td className="max-w-[220px] truncate px-2 py-1.5 text-faint" title={run.summary}>{run.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NotificationsList({ snapshot }: { snapshot: DashboardSnapshot }) {
  const items = snapshot.notifications ?? [];
  const configured = snapshot.notificationStatus.configured;
  const meta = snapshot.symbolMetaBySymbol ?? {};
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Chip tone={configured ? "up" : "warn"}>{configured ? "Webhook configured" : "Webhook not configured"}</Chip>
      </div>
      {items.length === 0 ? (
        <EmptyState title="No notification attempts recorded" />
      ) : (
        items.slice(0, 20).map((n) => {
          const display = formatNotificationDisplay(n, meta);
          return (
            <div key={n.id} className="border-b border-line/60 py-2">
              <div className="text-[11px] uppercase text-faint">{display.timestamp}</div>
              <div className="text-sm text-fg">{display.title}</div>
              <div className="text-[13px] text-muted">{display.detail}</div>
            </div>
          );
        })
      )}
    </div>
  );
}

/* ───────────────────────── Strategy Studio (modal) ───────────────────────── */

function StrategyStudio({
  snapshot,
  policy,
  editStrategyPrompt,
  resetPrompt,
  updatePolicy,
  requestStrategyTuning,
  tuningBusy,
  tuningError,
  strategyTuning,
  applyStrategyTuning
}: {
  snapshot: DashboardSnapshot;
  policy: TradingPolicy;
  editStrategyPrompt: (v: string) => void;
  resetPrompt: () => void;
  updatePolicy: (patch: PolicyPatch) => void;
  requestStrategyTuning: () => void;
  tuningBusy: boolean;
  tuningError: string;
  strategyTuning: StrategyTuningProposal | null;
  applyStrategyTuning: () => void;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-fg">Strategy prompt</h4>
          <Button size="sm" variant="ghost" onClick={resetPrompt}><RotateCcw size={13} /> Reset</Button>
        </div>
        <textarea
          value={snapshot.strategyPrompt}
          onChange={(e) => editStrategyPrompt(e.target.value)}
          className={cn(inputClass, "h-72 resize-none font-mono text-[13px] leading-relaxed")}
        />
        <p className="text-xs text-faint">Autosaves ~1s after you stop typing.</p>
      </div>

      <div className="space-y-4">
        <div>
          <h4 className="mb-2 text-sm font-semibold text-fg">Strategy sliders</h4>
          <div className="grid grid-cols-2 gap-2">
            <RangeField label="Max order $" value={policy.maxOrderNotional} min={1} max={1000} step={1} onCommit={(v) => updatePolicy({ maxOrderNotional: v })} />
            <RangeField label="Daily $" value={policy.maxDailyNotional} min={10} max={10000} step={10} onCommit={(v) => updatePolicy({ maxDailyNotional: v })} />
            <RangeField label="Symbol cap %" value={policy.maxSymbolExposurePct} min={1} max={100} step={1} onCommit={(v) => updatePolicy({ maxSymbolExposurePct: v })} />
            <RangeField label="Proposals/run" value={policy.maxProposalsPerRun} min={1} max={10} step={1} onCommit={(v) => updatePolicy({ maxProposalsPerRun: Math.round(v) })} />
            <RangeField label="Stop loss %" value={policy.riskRules.stopLossPct ?? 0} min={0} max={50} step={0.5} onCommit={(v) => updatePolicy({ riskRules: { ...policy.riskRules, stopLossPct: v } })} />
            <RangeField label="Take profit %" value={policy.riskRules.takeProfitPct ?? 0} min={0} max={100} step={0.5} onCommit={(v) => updatePolicy({ riskRules: { ...policy.riskRules, takeProfitPct: v } })} />
          </div>
        </div>

        <div>
          <h4 className="mb-2 text-sm font-semibold text-fg">Scoring weights</h4>
          <ScoringWeights weights={policy.scoringWeights} onCommit={(w) => updatePolicy({ scoringWeights: w })} />
        </div>
      </div>

      <div className="lg:col-span-2">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold text-fg">LLM strategy review</h4>
            <p className="text-xs text-faint">Reviews performance, scan context, macro & current prompt. Advisory — apply is manual.</p>
          </div>
          <Button size="sm" onClick={requestStrategyTuning} disabled={tuningBusy}><Zap size={14} /> {tuningBusy ? "Reviewing…" : "Review strategy"}</Button>
        </div>
        {tuningError && <p className="mb-2 rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-[13px] text-down">{tuningError}</p>}
        {strategyTuning ? <TuningCard proposal={strategyTuning} onApply={applyStrategyTuning} /> : <p className="text-[13px] text-faint">Run a review to get suggested prompt, scoring, and risk changes.</p>}
      </div>
    </div>
  );
}

function ScoringWeights({ weights, onCommit }: { weights: ScoringWeights; onCommit: (w: ScoringWeights) => void }) {
  const keys = Object.keys(weights) as Array<keyof ScoringWeights>;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {keys.map((k) => (
        <NumberField key={k} label={labelize(k)} value={weights[k]} onCommit={(v) => onCommit({ ...weights, [k]: v })} />
      ))}
    </div>
  );
}

/* ───────────────────────── Settings (modal) ───────────────────────── */

function SettingsContent({
  snapshot,
  policy,
  allowedCount,
  enableBlockedReason,
  remainingNotional,
  remainingOrders,
  updatePolicy
}: {
  snapshot: DashboardSnapshot;
  policy: TradingPolicy;
  allowedCount: number;
  enableBlockedReason?: string;
  remainingNotional: number;
  remainingOrders: number;
  updatePolicy: (patch: PolicyPatch) => void;
}) {
  type Section = "operate" | "risk" | "notifications";
  const [section, setSection] = useState<Section>("operate");
  const [sectorCaps, setSectorCaps] = useState(formatSectorCaps(policy.sectorCaps));
  const [draft, setDraft] = useState("");

  function addAllowlist() {
    const next = normalizeSymbols([...policy.allowlist, ...draft.split(/[,\s]+/)]);
    setDraft("");
    updatePolicy({ allowlist: next });
  }

  return (
    <div className="space-y-4">
      <Tabs
        value={section}
        onChange={setSection}
        tabs={[
          { id: "operate", label: "Operate" },
          { id: "risk", label: "Risk & limits" },
          { id: "notifications", label: "Notifications" }
        ]}
      />

      {section === "operate" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Account">
            <select className={inputClass} value={policy.accountNumber ?? ""} onChange={(e) => updatePolicy({ accountNumber: e.target.value })}>
              <option value="">Select account</option>
              {snapshot.accounts.map((a) => (
                <option key={a.accountNumber} value={a.accountNumber}>{a.label} {a.agenticAllowed ? "" : "(not agentic)"}</option>
              ))}
            </select>
          </Field>
          <Field label="Allowed universe">
            <select className={inputClass} value={policy.universe} onChange={(e) => updatePolicy({ universe: e.target.value as TradingPolicy["universe"] })}>
              <option value="custom">Custom allowlist</option>
              <option value="sp500">S&P 500 ({SP500_SYMBOLS.length} symbols)</option>
            </select>
          </Field>
          <Field label="Strategy authority" className="sm:col-span-2">
            <select className={inputClass} value={policy.strategyAuthority} onChange={(e) => updatePolicy({ strategyAuthority: e.target.value as TradingPolicy["strategyAuthority"] })}>
              <option value="propose">LLM proposes — you approve</option>
              <option value="decide">LLM decides — runs autonomously</option>
            </select>
          </Field>
          <Field label="Custom allowlist" hint={`${allowedCount} symbol${allowedCount === 1 ? "" : "s"} allowed`} className="sm:col-span-2">
            <div className="rounded-lg border border-line bg-bg/60 p-2">
              <div className="mb-2 flex flex-wrap gap-1.5">
                {(policy.universe === "sp500" ? [] : policy.allowlist).map((s) => (
                  <button key={s} onClick={() => updatePolicy({ allowlist: policy.allowlist.filter((x) => x !== s) })} className="inline-flex items-center gap-1 rounded-md bg-surface-3 px-2 py-0.5 text-xs text-fg">
                    {s} <X size={11} />
                  </button>
                ))}
              </div>
              <input
                disabled={policy.universe === "sp500"}
                value={draft}
                onChange={(e) => setDraft(e.target.value.toUpperCase())}
                onBlur={addAllowlist}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addAllowlist();
                  }
                }}
                placeholder="Add ticker, press Enter"
                className="w-full bg-transparent text-sm text-fg outline-none placeholder:text-faint disabled:opacity-50"
              />
            </div>
          </Field>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button
              variant={policy.enabled ? "ghost" : "primary"}
              disabled={!policy.enabled && Boolean(enableBlockedReason)}
              title={!policy.enabled ? enableBlockedReason : undefined}
              onClick={() => updatePolicy({ enabled: !policy.enabled, killSwitch: false })}
            >
              {policy.enabled ? <Pause size={15} /> : <Play size={15} />} {policy.enabled ? "Pause autonomy" : "Enable autonomy"}
            </Button>
            <Button variant="ghost" onClick={() => updatePolicy({ paperMode: !policy.paperMode })}>
              {policy.paperMode ? "Switch to Live" : "Switch to Paper"}
            </Button>
          </div>
          {!policy.enabled && enableBlockedReason && (
            <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[13px] text-warn sm:col-span-2"><AlertTriangle size={14} className="mr-1 inline" />{enableBlockedReason}</p>
          )}
        </div>
      )}

      {section === "risk" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label="Max order ($)" value={policy.maxOrderNotional} onCommit={(v) => updatePolicy({ maxOrderNotional: v })} />
          <NumberField label="Max daily notional ($)" value={policy.maxDailyNotional} onCommit={(v) => updatePolicy({ maxDailyNotional: v })} />
          <NumberField label="Max daily orders" value={policy.maxDailyOrders} onCommit={(v) => updatePolicy({ maxDailyOrders: Math.round(v) })} />
          <NumberField label="Max symbol (%)" value={policy.maxSymbolExposurePct} onCommit={(v) => updatePolicy({ maxSymbolExposurePct: v })} />
          <NumberField label="Max proposals/run" value={policy.maxProposalsPerRun} onCommit={(v) => updatePolicy({ maxProposalsPerRun: Math.round(v) })} />
          <NumberField label="Cadence (min)" value={policy.runCadenceMinutes} onCommit={(v) => updatePolicy({ runCadenceMinutes: Math.max(1, Math.round(v)) })} />
          <NumberField label="Stop loss (%)" value={policy.riskRules.stopLossPct ?? 0} onCommit={(v) => updatePolicy({ riskRules: { ...policy.riskRules, stopLossPct: v } })} />
          <NumberField label="Take profit (%)" value={policy.riskRules.takeProfitPct ?? 0} onCommit={(v) => updatePolicy({ riskRules: { ...policy.riskRules, takeProfitPct: v } })} />
          <NumberField label="Paper start ($)" value={policy.paperStartingCash} onCommit={(v) => updatePolicy({ paperStartingCash: Math.max(0, Math.round(v)) })} />
          <Field label="Sector caps" hint="e.g. Technology:25, Financials:20" className="sm:col-span-2">
            <input className={inputClass} value={sectorCaps} onChange={(e) => setSectorCaps(e.target.value)} onBlur={() => updatePolicy({ sectorCaps: parseSectorCaps(sectorCaps) })} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-muted sm:col-span-2">
            <input type="checkbox" checked={policy.runDuringExtendedHours} onChange={(e) => updatePolicy({ runDuringExtendedHours: e.target.checked })} />
            Run during extended hours
          </label>
          <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-muted sm:col-span-2">
            Remaining today: <span className="tnum text-fg">{money(remainingNotional)}</span> notional and <span className="tnum text-fg">{remainingOrders}</span> orders.
          </p>
        </div>
      )}

      {section === "notifications" && (
        <div className="space-y-3">
          <Field label="Notifications webhook">
            <input className={inputClass} value={policy.notificationSettings.webhookUrl ?? ""} onChange={(e) => updatePolicy({ notificationSettings: { ...policy.notificationSettings, webhookUrl: e.target.value } })} placeholder="https://…" />
          </Field>
          <div>
            <span className="mb-1.5 block text-xs font-medium text-muted">Send notifications for</span>
            <div className="grid grid-cols-2 gap-2">
              {(["fill", "block", "run_failed", "pending_approval", "kill_switch"] as const).map((eventType) => {
                const enabled = policy.notificationSettings.enabledEvents.includes(eventType);
                return (
                  <label key={eventType} className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm capitalize text-fg">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => {
                        const events = e.target.checked
                          ? Array.from(new Set([...policy.notificationSettings.enabledEvents, eventType]))
                          : policy.notificationSettings.enabledEvents.filter((x) => x !== eventType);
                        updatePolicy({ notificationSettings: { ...policy.notificationSettings, enabledEvents: events } as NotificationSettings });
                      }}
                    />
                    {eventType.replace("_", " ")}
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Form controls ───────────────────────── */

function NumberField({ label, value, onCommit }: { label: string; value?: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value ?? 0));
  useEffect(() => setDraft(String(value ?? 0)), [value]);
  return (
    <Field label={label}>
      <input
        type="number"
        min="0"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(Number(draft))}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className={inputClass}
      />
    </Field>
  );
}

function RangeField({ label, value, min, max, step, onCommit }: { label: string; value: number; min: number; max: number; step: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const safe = Math.max(min, Math.min(max, draft));
  return (
    <div className="rounded-lg border border-line bg-surface-2 p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase text-faint">{label}</span>
        <span className="tnum text-[13px] text-fg">{Number.isInteger(safe) ? safe : safe.toFixed(1)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={safe}
        onChange={(e) => setDraft(Number(e.target.value))}
        onMouseUp={() => onCommit(safe)}
        onTouchEnd={() => onCommit(safe)}
        onKeyUp={(e) => {
          if (e.key.startsWith("Arrow")) onCommit(safe);
        }}
        className="mt-1.5 w-full accent-accent"
      />
    </div>
  );
}

/* ───────────────────────── Helpers ───────────────────────── */

function statusTone(status: string): "up" | "down" | "warn" | "accent" | "neutral" {
  if (status === "filled" || status === "placed" || status === "paper" || status === "approved" || status === "completed") return "up";
  if (status === "blocked" || status === "rejected" || status === "failed") return "down";
  if (status === "pending_approval" || status === "pending" || status === "proposed") return "warn";
  return "neutral";
}

function displayStatus(status: string): string {
  if (status === "paper") return "PAPER";
  return status.toUpperCase();
}

function proposalSize(proposal: TradeProposal): string {
  if (proposal.dollarAmount) return money(proposal.dollarAmount);
  if (proposal.quantity) return `${formatShareQuantity(proposal.quantity, proposal.symbol)} sh`;
  return "—";
}

function compare(left: unknown, right: unknown, dir: SortDir): number {
  const order = dir === "asc" ? 1 : -1;
  if (typeof left === "string" || typeof right === "string") return String(left ?? "").localeCompare(String(right ?? "")) * order;
  return (Number(left ?? 0) - Number(right ?? 0)) * order;
}

function summarizeTuningPatch(proposal: StrategyTuningProposal): string[] {
  const patch = proposal.proposedPatch;
  const items: string[] = [];
  if (patch.prompt) items.push("Prompt rewrite proposed");
  for (const [key, value] of Object.entries(patch.scoringWeights ?? {})) items.push(`Weight ${labelize(key)} → ${formatPatchValue(value)}`);
  const policy = patch.policy ?? {};
  for (const [key, value] of Object.entries(policy)) {
    if (key === "riskRules" || value === undefined) continue;
    items.push(`${labelize(key)} → ${formatPatchValue(value)}`);
  }
  for (const [key, value] of Object.entries(policy.riskRules ?? {})) items.push(`${labelize(key)} → ${formatPatchValue(value)}`);
  return items;
}

function formatPatchValue(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function labelize(value: string): string {
  return value
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function formatSectorCaps(caps: Record<string, number>): string {
  return Object.entries(caps).map(([sector, cap]) => `${sector}:${cap}`).join(", ");
}

function parseSectorCaps(value: string): Record<string, number> {
  return Object.fromEntries(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [sector, cap] = item.split(":");
        return [sector?.trim() ?? "", Number(cap)] as const;
      })
      .filter(([sector, cap]) => sector.length > 0 && Number.isFinite(cap))
  );
}

function normalizeSymbols(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim().toUpperCase()).filter((v) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(v))));
}

function formatSources(sourceString: string): string {
  if (!sourceString) return "";
  return sourceString
    .split("+")
    .map((part) => {
      switch (part.trim().toLowerCase()) {
        case "nasdaq-delayed-screener":
          return "NASDAQ";
        case "finnhub":
          return "Finnhub";
        case "yahoo-finance":
          return "Yahoo";
        case "fmp":
          return "FMP";
        case "alpha-vantage":
          return "Alpha Vantage";
        default:
          return part.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      }
    })
    .join(", ");
}

function renderActionTitle(title: string) {
  const match = title.match(/^(Paper\s+)?(buy|sell|bought|sold|buy:|sell:)\b(.*)$/i);
  if (!match) return <span className="font-semibold text-fg">{title}</span>;
  const [, paperPrefix = "", action, rest] = match;
  const cls = /sell|sold/i.test(action) ? "text-down" : "text-up";
  return (
    <span className="font-semibold text-fg">
      {paperPrefix}
      <span className={cls}>{action.toUpperCase()}</span>
      {rest}
    </span>
  );
}
