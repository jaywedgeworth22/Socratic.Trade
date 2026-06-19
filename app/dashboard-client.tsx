"use client";

import {
  Activity as ActivityIcon,
  AlertTriangle,
  BrainCircuit,
  Check,
  CheckCircle,
  ChevronRight,
  Command as CommandIcon,
  ExternalLink,
  Gauge,
  Hourglass,
  Info,
  KeyRound,
  Landmark,
  LayoutDashboard,
  LineChartIcon,
  Network,
  Pause,
  Percent,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings as SettingsIcon,
  Shield,
  Sparkles,
  Trash2,
  TrendingUp,
  Wallet,
  X,
  XCircle,
  Zap
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { TableVirtuoso } from "react-virtuoso";
import { toast } from "sonner";
import { DEFAULT_STRATEGY_PROMPT } from "@/lib/defaults";
import { deriveMetrics } from "@/lib/derived-metrics";
import {
  cellTitle,
  companyTitle,
  enrichPositionsForDisplay,
  formatNotificationDisplay,
  formatShareQuantity,
  quoteTitle,
  ratingTitle,
  receivedLabel,
  sentimentTitle
} from "@/lib/dashboard-ui";
import type { EnrichedPosition } from "@/lib/dashboard-ui";
import { SP500_SYMBOLS } from "@/lib/sp500";
import type {
  EquityPosition,
  MarketQuote,
  MarketScan,
  NotificationSettings,
  ScoringWeights,
  StrategyTuningProposal,
  TradingPolicy,
  TradeProposal
} from "@/lib/types";
import type { DashboardSnapshot, UnifiedActivityGroup } from "./dashboard-types";
import { compactMoney, compactNum, formatPct, money, signedMoney } from "./dashboard-widgets";
import { cn } from "./ui/cn";
import dynamic from "next/dynamic";
const AllocationDonut = dynamic(() => import("./ui/charts").then((m) => m.AllocationDonut), { ssr: false });
const EquityCurve = dynamic(() => import("./ui/charts").then((m) => m.EquityCurve), { ssr: false });
const ScorecardBars = dynamic(() => import("./ui/charts").then((m) => m.ScorecardBars), { ssr: false });
import { CommandPalette, type Command } from "./ui/command-palette";
import { StrategyFlow } from "./ui/strategy-flow";
import { MacroBoardView } from "./ui/macro-panel";
import { SymbolDrilldown } from "./ui/symbol-drilldown";
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
type WorkspaceTab = "decision" | "market" | "macro" | "performance" | "tax" | "strategy";
type FeedTab = "activity" | "runs" | "notifications";
type RobinhoodMcpHealth = {
  adapter?: "mock" | "mcp";
  ok: boolean;
  configured: boolean;
  authenticated: boolean;
  url?: string;
  protocolVersion?: string;
  transport?: string;
  tools: string[];
  checkedAt: string;
  error?: string;
  warning?: string;
};

export function DashboardClient({ initialSnapshot }: { initialSnapshot: DashboardSnapshot }) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(initialSnapshot);
  const [busy, setBusy] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("decision");
  const [feedTab, setFeedTab] = useState<FeedTab>("activity");
  const [feedOpen, setFeedOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [nodeEditorOpen, setNodeEditorOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [killConfirm, setKillConfirm] = useState(false);
  const [drilldownSymbol, setDrilldownSymbol] = useState<MarketQuote | null>(null);
  // A live market scan used solely to resolve a symbol → full quote when a ticker is
  // clicked anywhere outside Market Scan. The persisted `latestStrategyRun.marketScan`
  // isn't rehydrated after a restart, so we fetch the current scan (same source the
  // Market Scan tab uses) once on mount and keep it for drilldown lookups.
  const [tickerScan, setTickerScan] = useState<MarketScan | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/scan")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: MarketScan | null) => {
        if (!cancelled && data && Array.isArray(data.topCandidates)) setTickerScan(data);
      })
      .catch(() => {
        /* ticker drilldown is a nice-to-have; ignore scan fetch failures */
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const [isMac, setIsMac] = useState(true);
  useEffect(() => {
    // Platform-aware command shortcut: ⌘K on macOS, Ctrl+K elsewhere (Windows/Linux).
    const platform = typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent || "" : "";
    setIsMac(/Mac|iPhone|iPad|iPod/i.test(platform));
  }, []);
  const shortcutLabel = isMac ? "⌘K" : "Ctrl+K";
  const shortcutIcon = isMac ? <><CommandIcon size={13} /> K</> : <span className="font-semibold text-xs rounded border border-line bg-surface px-1 py-0.5">Ctrl K</span>;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Honor the platform's modifier: Cmd on macOS, Ctrl on Windows/Linux.
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMac]);

  async function load(options: { quiet?: boolean } = {}) {
    if (!options.quiet) setBusy(true);
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      if (!response.ok) throw new Error(await response.text());
      setSnapshot((await response.json()) as DashboardSnapshot);
    } catch (loadError) {
      toast.error(loadError instanceof Error ? loadError.message : "Dashboard refresh failed.");
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
      toast.success("Policy updated.");
      await load({ quiet: true });
    } catch (policyError) {
      toast.error(policyError instanceof Error ? policyError.message : "Policy update failed.");
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
      toast.success(body.summary ?? "Strategy run completed.");
      await load({ quiet: true });
    } catch (runError) {
      toast.error(runError instanceof Error ? runError.message : "Strategy run failed.");
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
        toast.warning("Proposal blocked by policy", { description: reasonsMsg });
      } else {
        toast.success(
          body.status === "placed"
            ? `Order placed${body.orderId ? `: ${body.orderId}` : ""}.`
            : body.status === "paper"
              ? "Proposal executed in Paper mode."
              : `Result: ${body.status}`
        );
      }
      if (body.status === "placed" || body.status === "paper") await load({ quiet: true });
    } catch (approvalError) {
      const errMsg = approvalError instanceof Error ? approvalError.message : "Proposal approval failed.";
      toast.error("Execution error", { description: errMsg });
    } finally {
      setBusy(false);
    }
  }

  async function rejectProposal(proposalId: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/proposals/${proposalId}/reject`, { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      toast.info("Proposal rejected.");
      await load({ quiet: true });
    } catch (rejectError) {
      toast.error(rejectError instanceof Error ? rejectError.message : "Proposal rejection failed.");
    } finally {
      setBusy(false);
    }
  }

  async function activateProfile(profileId: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/profiles/${profileId}/activate`, { method: "POST" });
      if (!response.ok) throw new Error(await response.text());
      toast.success("Profile activated.");
      await load({ quiet: true });
    } catch (profileError) {
      toast.error(profileError instanceof Error ? profileError.message : "Profile activation failed.");
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
      toast.success("Profile created.");
      setNewProfileName("");
      await load({ quiet: true });
    } catch (profileError) {
      toast.error(profileError instanceof Error ? profileError.message : "Profile creation failed.");
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
    toast.success("Strategy tuning changes applied.");
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
  // Best available scan for resolving clicked tickers → full quotes: the freshly
  // fetched live scan, falling back to the captured run's scan if it's still loading.
  const drilldownScan = tickerScan ?? snapshot.latestStrategyRun?.marketScan ?? null;
  const dailyNotionalPct = policy.maxDailyNotional > 0 ? Math.round((dailyStats.notional / policy.maxDailyNotional) * 100) : 0;
  const pendingCount = snapshot.pendingProposals.length;
  const autonomyStatus = policy.killSwitch
    ? { tone: "down" as const, label: "Halted" }
    : policy.enabled
      ? { tone: "up" as const, label: "Autonomy On" }
      : { tone: "neutral" as const, label: "Autonomy Off" };
  const marketStatus = marketStatusFor(snapshot.marketSession);

  const commands: Command[] = [
    { id: "run", label: "Run strategy once", hint: "R", icon: <Zap size={15} />, run: () => void runStrategy() },
    { id: "refresh", label: "Refresh data", icon: <RefreshCw size={15} />, run: () => void load() },
    { id: "decision", label: "Go to Decision", icon: <LayoutDashboard size={15} />, run: () => setWorkspaceTab("decision") },
    { id: "market", label: "Go to Market Scan", icon: <LineChartIcon size={15} />, run: () => setWorkspaceTab("market") },
    { id: "macro", label: "Go to Macro", icon: <Landmark size={15} />, run: () => setWorkspaceTab("macro") },
    { id: "perf", label: "Go to Performance", icon: <TrendingUp size={15} />, run: () => setWorkspaceTab("performance") },
    { id: "tax", label: "Go to Tax", icon: <Landmark size={15} />, run: () => setWorkspaceTab("tax") },
    { id: "strategy", label: "Go to Strategy", icon: <BrainCircuit size={15} />, run: () => setWorkspaceTab("strategy") },
    { id: "studio", label: "Open Strategy Studio", icon: <BrainCircuit size={15} />, run: () => setStudioOpen(true) },
    { id: "flow", label: "Open Strategy Flow (Node Editor)", icon: <Network size={15} />, run: () => setNodeEditorOpen(true) },
    { id: "activity", label: "Open Activity feed", icon: <ActivityIcon size={15} />, run: () => setFeedOpen(true) },
    { id: "settings", label: "Open Settings", icon: <SettingsIcon size={15} />, run: () => setSettingsOpen(true) },
    { id: "accounts", label: "Manage accounts", icon: <Wallet size={15} />, run: () => setAccountsOpen(true) },
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
            <div className="whitespace-nowrap text-sm font-semibold text-fg">Agentic Trading</div>
            <div className="mt-0.5 space-y-0.5 text-[11px] text-muted">
              <div className="flex items-center gap-1.5 whitespace-nowrap">
                <Dot tone={autonomyStatus.tone} pulse={policy.enabled && !policy.killSwitch} />
                {autonomyStatus.label}
              </div>
              <div className="flex items-center gap-1.5 whitespace-nowrap">
                <Dot tone={marketStatus.tone} />
                {marketStatus.label}
              </div>
            </div>
          </div>
        </div>

        <div className="ml-2 hidden items-center gap-2 lg:flex">
          <StatusPill label="Portfolio" value={money(snapshot.portfolio?.totalMarketValue)} title={`Total ${mode} account value (cash + positions marked to current prices).`} />
          <StatusPill label="Buying power" value={money(snapshot.portfolio?.buyingPower)} title="Cash currently available to open new positions." />
          <DailyRiskPill pct={dailyNotionalPct} used={dailyStats.notional} cap={policy.maxDailyNotional} />
          <StatusPill label="Universe" value={policy.universe === "sp500" ? "S&P 500" : allowedCount === 0 ? "TBD" : `${allowedCount} tickers`} title="The set of symbols the agent is allowed to trade (Settings → Operate)." />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div
            className="hidden items-center gap-1.5 rounded-lg border border-line bg-surface/50 backdrop-blur-xl px-2.5 py-1 md:flex"
            title={policy.killSwitch ? "Kill switch is active — deactivate it to enable autonomy" : "Turn autonomous trading on or off"}
          >
            <span className="text-xs font-medium text-muted">Autonomy</span>
            <Switch
              checked={policy.enabled && !policy.killSwitch}
              onChange={(on) => updatePolicy({ enabled: on, ...(on ? { killSwitch: false } : {}) })}
              label="Autonomy"
            />
          </div>
          <div className="flex items-center gap-2">
            <select
              className="h-9 rounded-lg border border-line bg-surface/50 backdrop-blur-xl px-2.5 text-sm font-medium text-fg outline-none focus:border-accent"
              value={policy.connectedAccountId ?? ""}
              onChange={(e) => {
                const id = e.target.value;
                if (id === "manage") {
                  setAccountsOpen(true);
                  return;
                }
                void fetch(`/api/connected-accounts/${id}/activate`, { method: "POST" }).then(() => load());
              }}
            >
              <option value="" disabled>Select Account...</option>
              {snapshot.connectedAccounts?.map(acc => (
                <option key={acc.id} value={acc.id}>{acc.label} ({acc.environment})</option>
              ))}
              <option value="manage">Manage Accounts...</option>
            </select>
          </div>
          <button
            onClick={() => setPaletteOpen(true)}
            title="Open command palette"
            className="hidden items-center gap-1.5 rounded-lg border border-line bg-surface/50 backdrop-blur-xl px-2.5 py-1.5 text-xs text-muted transition-colors hover:text-fg md:flex"
          >
            {shortcutIcon}
          </button>
          <IconButton label="Refresh" onClick={() => load()} disabled={busy}>
            <RefreshCw size={15} className={cn(busy && "animate-spin")} />
          </IconButton>
          <button
            onClick={() => setFeedOpen(true)}
            className="relative inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface/50 backdrop-blur-xl px-3 text-sm font-medium text-fg transition-colors hover:bg-surface-2/50 backdrop-blur-lg"
          >
            <ActivityIcon size={15} /> Activity
            {pendingCount > 0 && (
              <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warn px-1 text-[10px] font-bold text-black">
                {pendingCount}
              </span>
            )}
          </button>
          <Button variant="ghost" size="sm" className="h-9" onClick={() => setNodeEditorOpen(true)}>
            <Network size={15} /> Flow
          </Button>
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
          <PortfolioRail snapshot={snapshot} mode={mode} symbolMetaBySymbol={symbolMetaBySymbol} scan={drilldownScan} onDrilldown={setDrilldownSymbol} />
        </aside>

        <main className="flex min-h-0 flex-col gap-3">
          <div className="flex items-center justify-between">
            <Tabs
              value={workspaceTab}
              onChange={setWorkspaceTab}
              tabs={[
                { id: "decision", label: "Decision" },
                { id: "market", label: "Market Scan" },
                { id: "macro", label: "Macro" },
                { id: "performance", label: "Performance" },
                { id: "tax", label: "Tax" },
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
                scan={drilldownScan}
                onDrilldown={setDrilldownSymbol}
              />
            )}
            {workspaceTab === "market" && (
              <div className="space-y-3">
                <MarketScanView snapshot={snapshot} onDrilldown={setDrilldownSymbol} />
                <SmartMoneyView snapshot={snapshot} scan={drilldownScan} onDrilldown={setDrilldownSymbol} />
              </div>
            )}
            {workspaceTab === "macro" && <MacroBoardView snapshot={snapshot} />}
            {workspaceTab === "performance" && <PerformanceView snapshot={snapshot} mode={mode} symbolMetaBySymbol={symbolMetaBySymbol} />}
            {workspaceTab === "tax" && <TaxView snapshot={snapshot} symbolMetaBySymbol={symbolMetaBySymbol} scan={drilldownScan} onDrilldown={setDrilldownSymbol} />}
            {workspaceTab === "strategy" && (
              <StrategyView
                snapshot={snapshot}
                policy={policy}
                updatePolicy={updatePolicy}
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

      <SlideOver open={!!drilldownSymbol} onClose={() => setDrilldownSymbol(null)} title="Symbol Intelligence" width="max-w-xl">
        {drilldownSymbol && <SymbolDrilldown quote={drilldownSymbol} />}
      </SlideOver>

      <Modal open={nodeEditorOpen} onClose={() => setNodeEditorOpen(false)} title="Strategy Flow" subtitle="Pipeline & node visualizer" icon={<Network size={18} />} size="full">
        <div className="h-full w-full">
          <StrategyFlow />
        </div>
      </Modal>

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

      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Settings" subtitle="Risk, tax & notifications" icon={<SettingsIcon size={18} />} size="lg">
        <SettingsContent
          snapshot={snapshot}
          policy={policy}
          allowedCount={allowedCount}
          enableBlockedReason={enableBlockedReason}
          remainingNotional={remainingNotional}
          remainingOrders={remainingOrders}
          updatePolicy={updatePolicy}
          load={load}
        />
      </Modal>

      <Modal open={accountsOpen} onClose={() => setAccountsOpen(false)} title="Accounts" subtitle="Connect & switch brokerage accounts" icon={<Wallet size={18} />} size="lg">
        <IntegrationsSection accounts={snapshot.connectedAccounts || []} onSaved={load} />
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

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
  );
}

/* ───────────────────────── Command-bar pieces ───────────────────────── */

function StatusPill({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex flex-col rounded-lg border border-line bg-surface/50 backdrop-blur-xl px-3 py-1" title={title}>
      <span className="text-[9px] font-semibold uppercase tracking-wide text-faint">{label}</span>
      <span className="tnum text-[13px] leading-tight text-fg">{value}</span>
    </div>
  );
}

function DailyRiskPill({ pct, used, cap }: { pct: number; used: number; cap: number }) {
  const tone = pct >= 90 ? "down" : pct >= 60 ? "warn" : "accent";
  const bar = tone === "down" ? "bg-down" : tone === "warn" ? "bg-warn" : "bg-accent";
  return (
    <div className="flex flex-col rounded-lg border border-line bg-surface/50 backdrop-blur-xl px-3 py-1" title={`${money(used)} of ${money(cap)} daily notional used`}>
      <span className="text-[9px] font-semibold uppercase tracking-wide text-faint">Daily risk</span>
      <div className="flex items-center gap-1.5">
        <span className="tnum text-[13px] leading-tight text-fg">{pct}%</span>
        <span className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-3/50 backdrop-blur-md">
          <span className={cn("block h-full rounded-full", bar)} style={{ width: `${Math.min(100, pct)}%` }} />
        </span>
      </div>
    </div>
  );
}


/* ───────────────────────── Portfolio rail ───────────────────────── */

function PortfolioRail({
  snapshot,
  mode,
  symbolMetaBySymbol,
  scan,
  onDrilldown
}: {
  snapshot: DashboardSnapshot;
  mode: "paper" | "live";
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
  scan: MarketScan | null;
  onDrilldown: (q: MarketQuote) => void;
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
            <thead className="sticky top-0 bg-surface/50 backdrop-blur-xl">
              <tr className="text-[11px] uppercase text-faint">
                <th className="px-2 py-1.5 text-left font-semibold">Symbol</th>
                <th className="px-2 py-1.5 text-right font-semibold">Value</th>
                <th className="px-2 py-1.5 text-right font-semibold">P&L</th>
              </tr>
            </thead>
            <tbody>
              {enriched.map((p) => (
                <tr key={p.symbol} className="border-t border-line/60 hover:bg-surface-2/50 backdrop-blur-lg">
                  <td className="px-2 py-1.5">
                    <SymbolButton symbol={p.symbol} scan={scan} onDrilldown={onDrilldown} className="block font-semibold text-fg" title={companyTitle(p.symbol, symbolMetaBySymbol)} />
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

/* ───────────────────────── Clickable ticker ───────────────────────── */

/**
 * Resolve a full MarketQuote for a symbol from the captured run's scan so the
 * symbol drilldown can open from anywhere — not just the Market Scan table.
 * Prefers the fully-scored `topCandidates`; falls back to the lighter
 * `quotesBySymbol` summary (filling only the MarketQuote-required fields, leaving
 * the rest undefined so the drawer renders "—" rather than fabricated numbers).
 */
function resolveScanQuote(symbol: string, scan: MarketScan | null | undefined): MarketQuote | null {
  if (!scan) return null;
  const full = scan.topCandidates.find((q) => q.symbol === symbol);
  if (full) return full;
  const summary = scan.quotesBySymbol[symbol];
  if (!summary) return null;
  return { ...summary, volume: 0, intradayChangePct: 0, positionMarketValue: 0 };
}

/**
 * A ticker that opens the symbol drilldown when we have scan data for it,
 * mirroring the Market Scan rows. Degrades to plain text when no `onDrilldown`
 * handler is wired up or the symbol isn't in the scan, so it's a drop-in for the
 * `<span>{symbol}</span>` ticker pattern used across the dashboard.
 *
 * - `variant="underline"` (default): a quiet, always-visible underline that thickens
 *   to link-blue on hover. Used for plain text tickers anywhere on the site.
 * - `variant="chip"`: for a ticker sitting inside an already-colored Chip (e.g. the red
 *   wash-sale lockout). Keeps the chip's color and box; on hover it goes bold-italic +
 *   underline instead of turning blue, so the chip's meaning (red = locked) is preserved.
 */
function SymbolButton({
  symbol,
  scan,
  quote: quoteProp,
  onDrilldown,
  className,
  title,
  variant = "underline"
}: {
  symbol: string;
  scan?: MarketScan | null;
  quote?: MarketQuote | null;
  onDrilldown?: (q: MarketQuote) => void;
  className?: string;
  title?: string;
  variant?: "underline" | "chip";
}) {
  // Prefer an explicitly-provided quote (e.g. the Market Scan row already has it);
  // otherwise resolve it from the scan by symbol.
  const quote = quoteProp ?? (onDrilldown ? resolveScanQuote(symbol, scan) : null);
  if (!quote || !onDrilldown) {
    return <span className={className} title={title}>{symbol}</span>;
  }
  const interactive =
    variant === "chip"
      ? // Inherit the chip's color/box; signal interactivity with weight + italic on hover.
        "cursor-pointer transition-all duration-150 underline-offset-2 hover:font-bold hover:italic hover:underline active:scale-95 focus:outline-none focus-visible:rounded-sm focus-visible:ring-1 focus-visible:ring-current"
      : // Always-on faint underline as the at-rest cue; thickens to link-blue on hover.
        "cursor-pointer underline decoration-1 decoration-faint/50 underline-offset-[3px] transition-all duration-150 hover:text-info hover:decoration-2 hover:decoration-info active:scale-95 focus:outline-none focus-visible:rounded-sm focus-visible:ring-1 focus-visible:ring-info";
  return (
    <button
      type="button"
      title={title ?? "Open symbol intelligence"}
      onClick={(e) => {
        e.stopPropagation();
        onDrilldown(quote);
      }}
      className={cn(className, interactive)}
    >
      {symbol}
    </button>
  );
}

/* ───────────────────────── Decision view ───────────────────────── */

function DecisionView({
  snapshot,
  symbolMetaBySymbol,
  busy,
  approve,
  reject,
  scan,
  onDrilldown
}: {
  snapshot: DashboardSnapshot;
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
  busy: boolean;
  approve: (id: string) => void;
  reject: (id: string) => void;
  scan: MarketScan | null;
  onDrilldown: (q: MarketQuote) => void;
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
              <div key={p.id} className="rounded-xl border border-line bg-surface-2/50 backdrop-blur-lg p-3">
                <div className="flex items-center gap-2">
                  <Chip tone={p.proposal.side === "buy" ? "up" : "down"}>{p.proposal.side.toUpperCase()}</Chip>
                  <SymbolButton symbol={p.proposal.symbol} scan={scan} onDrilldown={onDrilldown} className="text-base font-semibold text-fg" title={companyTitle(p.proposal.symbol, symbolMetaBySymbol)} />
                  <span className="ml-auto tnum text-xs text-muted" title="Estimated total cost and share count. The '~' means it's an estimate — the actual fill price (and so the exact shares) can differ slightly.">{proposalSize(p.proposal, p.review?.estimatedNotional, decision?.marketScan?.quotesBySymbol[p.proposal.symbol]?.price)}</span>
                </div>
                <p className="mt-2 line-clamp-3 text-[13px] leading-snug text-muted" title={p.proposal.rationale}>{p.proposal.rationale}</p>
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
          title="Latest decisions"
          subtitle={decision?.marketScan ? `${decision.marketScan.scannedSymbols} symbols scanned · ${formatSources(decision.marketScan.source)}` : "Run the strategy to generate a decision"}
          icon={<Sparkles size={16} />}
        />
        {!decision ? (
          <EmptyState icon={<BrainCircuit size={20} />} title="No decision yet" hint="Hit Run (or open the command palette → Run strategy once) to generate the agent's first decision." />
        ) : (
          <div className="space-y-3 p-4 pt-3">
            <div className={cn("rounded-xl border px-3 py-2 text-[13px]", decision.status === "failed" ? "border-down/30 bg-down/10 text-down" : "border-info/25 bg-info/10 text-fg")}>
              {decision.summary}
            </div>
            {decision.proposals.map((item, i) => (
              <div key={`${item.proposal.symbol}-${i}`} className="rounded-xl border border-line bg-surface-2/50 backdrop-blur-lg p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={statusTone(item.status)}>{displayStatus(item.status)}</Chip>
                  <Chip tone={item.proposal.side === "buy" ? "up" : "down"}>{item.proposal.side.toUpperCase()}</Chip>
                  <SymbolButton symbol={item.proposal.symbol} scan={scan} onDrilldown={onDrilldown} className="font-semibold text-fg" title={companyTitle(item.proposal.symbol, symbolMetaBySymbol)} />
                  <span className="tnum text-xs text-muted" title="Estimated total cost and share count. The '~' means it's an estimate — the actual fill price (and so the exact shares) can differ slightly.">{proposalSize(item.proposal, undefined, decision?.marketScan?.quotesBySymbol[item.proposal.symbol]?.price)} · {item.proposal.type}</span>
                  {item.proposal.tradeThesisTag && <Chip tone="accent">{item.proposal.tradeThesisTag}</Chip>}
                </div>
                <p className="mt-2 text-[13px] leading-snug text-muted">{item.proposal.rationale}</p>
                {item.reasons.length > 0 && <p className="mt-1.5 rounded bg-surface-3/50 backdrop-blur-md px-2 py-1 text-[11px] text-faint">{item.reasons.join("; ")}</p>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ───────────────────────── Market scan view ───────────────────────── */

const DASH = <span className="text-faint">—</span>;

type ScanColumn = {
  id: string;
  label: string;
  title: string; // rich header tooltip: acronym expansion + methodology + source
  align?: "right";
  defaultHidden?: boolean;
  /** Sort by a raw quote field… */
  sortKey?: keyof MarketQuote;
  /** …or by a computed value (for backend-derived columns not stored on the quote). */
  sortValue?: (q: MarketQuote) => number | string | undefined;
  render: (q: MarketQuote) => React.ReactNode;
  cellClass?: (q: MarketQuote) => string;
  cellTitle?: (q: MarketQuote) => string | undefined;
};

/** Resolve the value a column sorts on — its computed value if any, else the raw quote field. */
function scanSortValue(col: ScanColumn, q: MarketQuote): unknown {
  if (col.sortValue) return col.sortValue(q);
  return col.sortKey ? q[col.sortKey] : undefined;
}

const SCAN_COLUMNS: ScanColumn[] = [
  { id: "symbol", label: "Symbol", title: "Ticker symbol. Hover a row for the company name.", sortKey: "symbol",
    render: (q) => <span className="font-semibold text-fg">{q.symbol}</span>, cellTitle: (q) => q.companyName },
  { id: "price", label: "Price", title: "Last traded price (delayed). Source: NASDAQ delayed screener, refined by Yahoo / broker quotes when available.", align: "right", sortKey: "price",
    render: (q) => <span className="tnum">{money(q.price)}</span>, cellTitle: (q) => quoteTitle("Quote", q) },
  { id: "intradayChangePct", label: "Chg", title: "Intraday price change, percent vs the prior session's close.", align: "right", sortKey: "intradayChangePct",
    render: (q) => <span className="tnum">{formatPct(q.intradayChangePct)}</span>, cellClass: (q) => (q.intradayChangePct >= 0 ? "text-up" : "text-down") },
  { id: "volume", label: "Vol", title: "Shares traded today (falls back to the 10-day average when reported after hours). Source: screener / Finnhub.", align: "right", sortKey: "volume",
    render: (q) => (q.volume > 0 ? <span className="tnum text-muted">{compactNum(q.volume)}</span> : DASH) },
  { id: "marketCap", label: "Mkt Cap", title: "Market capitalization = share price × shares outstanding.", align: "right", sortKey: "marketCap",
    render: (q) => (q.marketCap && q.marketCap > 0 ? <span className="tnum text-muted">{compactMoney(q.marketCap)}</span> : DASH) },
  { id: "peRatio", label: "P/E", title: "Price-to-Earnings ratio = price ÷ trailing-12-month earnings per share; lower is cheaper relative to earnings. 'n/a' = negative/zero earnings (no meaningful ratio); '—' = no data. Source: Yahoo / FMP / Finnhub.", align: "right", sortKey: "peRatio",
    render: (q) => <span className="tnum text-muted">{q.peRatio && q.peRatio > 0 ? q.peRatio.toFixed(1) : typeof q.eps === "number" && q.eps <= 0 ? "n/a" : "—"}</span>, cellTitle: (q) => cellTitle("P/E ratio", q.sources?.peRatio) },
  { id: "fcfYield", label: "FCF%", title: "Free-cash-flow yield = trailing free cash flow ÷ market cap; higher means more cash generated per dollar of value. Source: Yahoo Finance.", align: "right", sortKey: "fcfYield",
    render: (q) => (typeof q.fcfYield === "number" ? <span className="tnum text-muted">{q.fcfYield.toFixed(1)}%</span> : DASH), cellTitle: (q) => cellTitle("Free-cash-flow yield", q.sources?.fcfYield) },
  { id: "debtToEquity", label: "D/E", title: "Debt-to-Equity = total debt ÷ shareholder equity; lower means less leverage. Source: Yahoo Finance.", align: "right", sortKey: "debtToEquity",
    render: (q) => (typeof q.debtToEquity === "number" ? <span className="tnum text-muted">{q.debtToEquity > 10 ? (q.debtToEquity / 100).toFixed(2) : q.debtToEquity.toFixed(2)}</span> : DASH), cellTitle: (q) => cellTitle("Debt / equity", q.sources?.debtToEquity) },
  { id: "epsGrowth", label: "EPS gr", title: "Earnings-per-share growth, year over year (e.g. +15%). Source: Yahoo Finance.", align: "right", sortKey: "epsGrowth",
    render: (q) => (typeof q.epsGrowth === "number" ? <span className="tnum">{(q.epsGrowth * 100).toFixed(0)}%</span> : DASH), cellClass: (q) => (typeof q.epsGrowth === "number" ? (q.epsGrowth >= 0 ? "text-up" : "text-down") : ""), cellTitle: (q) => cellTitle("EPS growth (YoY)", q.sources?.epsGrowth) },
  { id: "dividendYield", label: "Div", title: "Annual dividend yield = trailing dividends per share ÷ price. Source: Yahoo / Finnhub.", align: "right", sortKey: "dividendYield",
    render: (q) => (typeof q.dividendYield === "number" ? <span className="tnum text-muted">{q.dividendYield.toFixed(2)}%</span> : DASH) },
  // ── Backend-derived ratios (computed by us, not returned by any API). See src/lib/derived-metrics.ts. ──
  { id: "peg", label: "PEG", title: "[CALCULATED] PEG ratio = P/E ÷ EPS-growth%. <1 is cheap for its growth, >2 is expensive. Blank when unprofitable or no growth.", align: "right", sortValue: (q) => deriveMetrics(q).peg,
    render: (q) => { const v = deriveMetrics(q).peg; return typeof v === "number" ? <span className="tnum">{v.toFixed(2)}</span> : DASH; },
    cellClass: (q) => { const v = deriveMetrics(q).peg; return typeof v === "number" ? (v < 1 ? "text-up" : v > 2.5 ? "text-down" : "") : ""; } },
  { id: "roe", label: "ROE", title: "[CALCULATED] Return on equity = EPS ÷ book value per share, where BVPS = price ÷ P/B. Higher = more efficient use of capital; negative = losing money on equity.", align: "right", sortValue: (q) => deriveMetrics(q).roe,
    render: (q) => { const v = deriveMetrics(q).roe; return typeof v === "number" ? <span className="tnum">{v.toFixed(1)}%</span> : DASH; },
    cellClass: (q) => { const v = deriveMetrics(q).roe; return typeof v === "number" ? (v >= 0 ? "text-up" : "text-down") : ""; } },
  { id: "earnYld", label: "Earn Yld", title: "[CALCULATED] Earnings yield = EPS ÷ price (the inverse of P/E). Usable when P/E is n/a; negative = the company is losing money.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).earnYld,
    render: (q) => { const v = deriveMetrics(q).earnYld; return typeof v === "number" ? <span className="tnum text-muted">{v.toFixed(2)}%</span> : DASH; },
    cellClass: (q) => { const v = deriveMetrics(q).earnYld; return typeof v === "number" ? (v >= 0 ? "text-up" : "text-down") : ""; } },
  { id: "payout", label: "Payout", title: "[CALCULATED] Dividend payout ratio = dividends per share ÷ EPS. >100% means the dividend exceeds earnings and may be unsustainable.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).payout,
    render: (q) => { const v = deriveMetrics(q).payout; return typeof v === "number" ? <span className="tnum text-muted">{v.toFixed(0)}%</span> : DASH; },
    cellClass: (q) => { const v = deriveMetrics(q).payout; return typeof v === "number" && v > 100 ? "text-down" : ""; } },
  { id: "dollarVolM", label: "$ Vol", title: "[CALCULATED] Daily dollar volume = price × volume — liquidity gauge for position sizing and slippage.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).dollarVolM,
    render: (q) => { const v = deriveMetrics(q).dollarVolM; return typeof v === "number" ? <span className="tnum text-muted">{compactMoney(v * 1e6)}</span> : DASH; } },
  { id: "spreadBps", label: "Spread", title: "[CALCULATED] Bid-ask spread in basis points = (ask − bid) ÷ mid × 10000 — execution cost; wide spreads favor limit orders.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).spreadBps,
    render: (q) => { const v = deriveMetrics(q).spreadBps; return typeof v === "number" ? <span className="tnum text-muted">{v.toFixed(1)}</span> : DASH; } },
  { id: "sectorRelStrength", label: "Sec RS", title: "[CALCULATED] Sector relative strength = this name's intraday % move minus the average move of its sector among the scan candidates. Positive = outperforming its sector today.", align: "right", defaultHidden: true, sortKey: "sectorRelStrength",
    render: (q) => (typeof q.sectorRelStrength === "number" ? <span className="tnum">{q.sectorRelStrength >= 0 ? "+" : ""}{q.sectorRelStrength.toFixed(2)}%</span> : DASH),
    cellClass: (q) => (typeof q.sectorRelStrength === "number" ? (q.sectorRelStrength >= 0 ? "text-up" : "text-down") : "") },
  { id: "marginOfSafety", label: "MoS", title: "[CALCULATED] Margin of safety = (Graham value − price) ÷ price, where Graham value = √(22.5 × EPS × book value per share). Positive = trading below intrinsic value.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).marginOfSafety,
    render: (q) => { const v = deriveMetrics(q).marginOfSafety; return typeof v === "number" ? <span className="tnum">{v >= 0 ? "+" : ""}{v.toFixed(0)}%</span> : DASH; },
    cellClass: (q) => { const v = deriveMetrics(q).marginOfSafety; return typeof v === "number" ? (v >= 0 ? "text-up" : "text-down") : ""; } },
  { id: "pctFromHigh", label: "% off Hi", title: "[CALCULATED] % from the 52-week high = (price − 52w high) ÷ high. 0 = at the high (breakout zone); deeply negative = a large pullback.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).pctFromHigh,
    render: (q) => { const v = deriveMetrics(q).pctFromHigh; return typeof v === "number" ? <span className="tnum text-muted">{v.toFixed(1)}%</span> : DASH; } },
  { id: "rr52w", label: "R:R", title: "[CALCULATED] Reward:risk to the 52-week band = (52w high − price) ÷ (price − 52w low). >1 = more upside room to the high than downside to the low.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).rr52w,
    render: (q) => { const v = deriveMetrics(q).rr52w; return typeof v === "number" ? <span className="tnum text-muted">{v.toFixed(2)}</span> : DASH; } },
  { id: "shortPercentOfFloat", label: "Short %", title: "Percent of the tradable float sold short. High (>15–20%) raises short-squeeze potential but also signals bearish positioning. Source: Yahoo Finance.", align: "right", defaultHidden: true, sortKey: "shortPercentOfFloat",
    render: (q) => (typeof q.shortPercentOfFloat === "number" ? <span className="tnum text-muted">{q.shortPercentOfFloat.toFixed(1)}%</span> : DASH) },
  { id: "beta", label: "Beta", title: "Beta — sensitivity to the broad market (1.0 = moves with the market; >1 amplifies moves, <1 dampens them). Source: Yahoo Finance.", align: "right", defaultHidden: true, sortKey: "beta",
    render: (q) => (typeof q.beta === "number" ? <span className="tnum text-muted">{q.beta.toFixed(2)}</span> : DASH) },
  { id: "bid", label: "Bid", title: "Best bid — the highest price a buyer is currently willing to pay. Shown when broker quotes are available.", align: "right", defaultHidden: true, sortKey: "bid",
    render: (q) => (typeof q.bid === "number" ? <span className="tnum text-muted">{money(q.bid)}</span> : DASH) },
  { id: "ask", label: "Ask", title: "Best ask — the lowest price a seller is currently willing to accept. Shown when broker quotes are available.", align: "right", defaultHidden: true, sortKey: "ask",
    render: (q) => (typeof q.ask === "number" ? <span className="tnum text-muted">{money(q.ask)}</span> : DASH) },
  { id: "sentiment", label: "Sentiment", title: "News sentiment 0–100 (50 = neutral), scored from recent headlines with keyword/NLP analysis. Source: Alpha Vantage / Finnhub.", sortKey: "sentiment",
    render: (q) => (typeof q.sentiment === "number" ? <SentimentChip value={q.sentiment} /> : DASH), cellTitle: (q) => sentimentTitle(q) },
  { id: "analystScore", label: "Rating", title: "Analyst consensus 0–100, blended across providers (Strong Buy = 100 … Strong Sell = 0). Source: Yahoo / FMP / Finnhub.", sortKey: "analystScore",
    render: (q) => (q.analystRating ? <RatingChip score={q.analystScore} label={q.analystRating} /> : DASH), cellTitle: (q) => ratingTitle(q) },
  { id: "senateTrades", label: "Congress", title: "Net recent congressional trades = distinct members buying minus selling over the last ~60 days; positive = net buying (a positioning tailwind). Source: U.S. Senate eFD + Capitol Trades. Hover a cell for the disclosures.", align: "right", sortKey: "senateTrades",
    render: (q) => (typeof q.senateTrades === "number" ? <span className="tnum">{q.senateTrades > 0 ? `+${q.senateTrades}` : q.senateTrades}</span> : DASH), cellClass: (q) => (typeof q.senateTrades === "number" && q.senateTrades !== 0 ? (q.senateTrades > 0 ? "text-up" : "text-down") : ""), cellTitle: (q) => q.evidenceBulletins?.join("\n") || "No recent congressional disclosures for this symbol." },
  { id: "sector", label: "Sector", title: "Company sector classification. Source: Yahoo / Finnhub.", sortKey: "sector",
    render: (q) => (q.sector ? <Chip tone="info">{q.sector}</Chip> : DASH) },
  { id: "score", label: "Score", title: "Composite 0–100 score = weighted blend of liquidity, momentum, value, quality, volatility, sentiment & diversification factors. Adjust the weights on the Strategy tab.", align: "right", sortKey: "score",
    render: (q) => <span className="tnum font-semibold text-fg">{q.score.toFixed(1)}</span> }
];

const DEFAULT_SCAN_COLS = SCAN_COLUMNS.filter((c) => !c.defaultHidden).map((c) => c.id);
const SCAN_COLS_KEY = "scan-visible-cols";

function MarketScanView({ snapshot, onDrilldown }: { snapshot: DashboardSnapshot, onDrilldown: (q: MarketQuote) => void }) {
  const [sort, setSort] = useState<{ col: string; dir: SortDir }>({ col: "score", dir: "desc" });
  const [visible, setVisible] = useState<string[]>(DEFAULT_SCAN_COLS);
  const [colsOpen, setColsOpen] = useState(false);
  const [liveScan, setLiveScan] = useState<MarketScan | null>(null);
  const [scanLoading, setScanLoading] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(SCAN_COLS_KEY);
      if (saved) {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr) && arr.length > 0) setVisible(arr.filter((id) => SCAN_COLUMNS.some((c) => c.id === id)));
      }
    } catch {
      /* ignore */
    }
  }, []);

  function toggleCol(id: string) {
    if (id === "symbol") return; // symbol is always shown
    const next = visible.includes(id) ? visible.filter((c) => c !== id) : [...visible, id];
    setVisible(next);
    try {
      localStorage.setItem(SCAN_COLS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }

  const refreshScan = useCallback(async () => {
    setScanLoading(true);
    try {
      const res = await fetch("/api/scan");
      if (res.ok) {
        const data = (await res.json()) as MarketScan;
        if (data && Array.isArray(data.topCandidates)) setLiveScan(data);
      }
    } catch {
      /* keep the captured scan as fallback */
    } finally {
      setScanLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshScan();
  }, [refreshScan]);

  const scan = liveScan ?? snapshot.latestStrategyRun?.marketScan;
  if (!scan) {
    return (
      <Card>
        <PanelHeader
          title="Market scan"
          icon={<LineChartIcon size={16} />}
          actions={
            <IconButton label="Run scan" onClick={() => void refreshScan()} disabled={scanLoading}>
              <RefreshCw size={14} className={cn(scanLoading && "animate-spin")} />
            </IconButton>
          }
        />
        <EmptyState icon={<LineChartIcon size={20} />} title={scanLoading ? "Scanning the market…" : "No market scan yet"} hint="Refresh to scan the current market, or run the strategy to capture one." />
      </Card>
    );
  }
  const cols = SCAN_COLUMNS.filter((c) => visible.includes(c.id));
  // The quote `asOf` is a display string, not a timestamp; the scan's ISO generatedAt
  // is the real "received" time for every value in this table.
  const dataReceived = receivedLabel(scan.generatedAt);
  const sortCol = SCAN_COLUMNS.find((c) => c.id === sort.col);
  const sorted = sortCol
    ? [...scan.topCandidates].sort((a, b) => compare(scanSortValue(sortCol, a), scanSortValue(sortCol, b), sort.dir))
    : [...scan.topCandidates];
  return (
    <Card className="overflow-hidden">
      <PanelHeader
        title="Market scan"
        subtitle={`${scan.returnedQuotes} quotes · ${formatSources(scan.source)}${liveScan ? " · live" : scan.cached ? " · cached" : ""}`}
        icon={<LineChartIcon size={16} />}
        actions={
          <div className="flex items-center gap-1.5">
            <Chip tone="neutral">{new Date(scan.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</Chip>
            <IconButton label="Refresh scan" onClick={() => void refreshScan()} disabled={scanLoading}>
              <RefreshCw size={14} className={cn(scanLoading && "animate-spin")} />
            </IconButton>
            <div className="relative">
              <IconButton label="Configure columns" onClick={() => setColsOpen((v) => !v)}>
                <SettingsIcon size={14} />
              </IconButton>
              {colsOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setColsOpen(false)} />
                  <div className="absolute right-0 z-20 mt-1 max-h-[60vh] w-48 overflow-auto rounded-lg border border-line bg-surface/50 backdrop-blur-xl p-1.5 shadow-[var(--shadow-lg)]">
                    <p className="px-2 py-1 text-[11px] font-semibold uppercase text-faint">Show columns</p>
                    {SCAN_COLUMNS.map((c) => (
                      <label key={c.id} className={cn("flex items-center gap-2 rounded px-2 py-1 text-[13px] text-muted", c.id === "symbol" ? "opacity-50" : "cursor-pointer hover:bg-surface-2/50 backdrop-blur-lg")} title={c.title}>
                        <input type="checkbox" checked={visible.includes(c.id)} onChange={() => toggleCol(c.id)} disabled={c.id === "symbol"} className="accent-[var(--accent)]" />
                        {c.label}
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        }
      />
      <div className="p-2 h-[600px]">
        <TableVirtuoso
          data={sorted}
          components={{
            Table: (props) => <table {...props} className="w-full text-[13px]" />,
            TableHead: React.forwardRef((props, ref) => <thead {...props} ref={ref} className="bg-surface/50 backdrop-blur-xl" />),
            TableRow: (props) => <tr {...props} onClick={() => onDrilldown(props.item)} className="border-b border-line/50 hover:bg-surface-2/50 backdrop-blur-lg cursor-pointer transition-colors" />,
          }}
          fixedHeaderContent={() => (
            <tr className="border-b border-line text-[11px] uppercase text-faint bg-surface/50 backdrop-blur-xl shadow-sm">
              {cols.map((c) => (
                <th
                  key={c.id}
                  title={c.title}
                  onClick={() => setSort((s) => ({ col: c.id, dir: s.col === c.id && s.dir === "desc" ? "asc" : "desc" }))}
                  className={cn("cursor-pointer select-none whitespace-nowrap px-2.5 py-2 font-semibold hover:text-fg", c.align === "right" ? "text-right" : "text-left")}
                >
                  {c.label}
                  <span className="ml-0.5 text-faint">{sort.col === c.id ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
                </th>
              ))}
            </tr>
          )}
          itemContent={(index, q) => (
            <>
              {cols.map((c) => (
                <td key={c.id} title={[c.cellTitle?.(q), dataReceived].filter(Boolean).join("\n") || undefined} className={cn("px-2.5 py-1.5", c.align === "right" && "text-right", c.cellClass?.(q))}>
                  {c.id === "symbol" ? (
                    <SymbolButton symbol={q.symbol} quote={q} onDrilldown={onDrilldown} className="font-semibold text-fg" title={q.companyName ?? "Open symbol intelligence"} />
                  ) : (
                    c.render(q)
                  )}
                </td>
              ))}
            </>
          )}
        />
      </div>
    </Card>
  );
}

function SentimentChip({ value }: { value: number }) {
  const tone = value >= 60 ? "up" : value <= 40 ? "down" : "neutral";
  const label = value >= 60 ? "Positive" : value <= 40 ? "Negative" : "Neutral";
  return <Chip tone={tone}>{label} {value}</Chip>;
}

function freshness(fetchedAt?: string): string {
  if (!fetchedAt) return "never";
  const mins = Math.round((Date.now() - new Date(fetchedAt).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

/** Surfaces the full scraped congressional + insider datasets (the scan's Congress column
 *  only shows symbols that overlap the scan; this shows everything recently disclosed). */
function SmartMoneyView({ snapshot, scan, onDrilldown }: { snapshot: DashboardSnapshot; scan: MarketScan | null; onDrilldown: (q: MarketQuote) => void }) {
  const sm = snapshot.smartMoney;
  const ws = snapshot.webSources;
  const congress = sm?.congress ?? [];
  const insider = sm?.insider ?? [];
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card className="overflow-hidden">
        <PanelHeader
          title="Congressional trades"
          subtitle={ws?.congress ? `${ws.congress.recordCount} on file · ${ws.congress.sources.join("+") || "—"} · ${freshness(ws.congress.fetchedAt)}` : "Senate eFD + Capitol Trades"}
          icon={<Landmark size={16} />}
        />
        {congress.length === 0 ? (
          <EmptyState icon={<Landmark size={20} />} title="No disclosures cached yet" hint="The connector refreshes daily in the background; check back after the next refresh." />
        ) : (
          <div className="max-h-72 overflow-auto p-2">
            {congress.map((t, i) => (
              <div key={`${t.symbol}-${t.member}-${t.tradedAt}-${i}`} className="flex items-center gap-2 border-b border-line/50 px-2 py-1.5 text-[13px] last:border-0">
                <Chip tone={t.side === "buy" ? "up" : "down"}>{t.side === "buy" ? "BUY" : "SELL"}</Chip>
                <SymbolButton symbol={t.symbol} scan={scan} onDrilldown={onDrilldown} className="font-semibold text-fg" title={companyTitle(t.symbol, snapshot.symbolMetaBySymbol ?? {})} />
                <span className="truncate text-muted" title={`${t.member} (${t.chamber})`}>{t.member}</span>
                <span className="ml-auto whitespace-nowrap text-faint">{t.tradedAt}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <PanelHeader
          title="Insider (Form 4) activity"
          subtitle={ws?.insider ? `${ws.insider.recordCount} on file · SEC EDGAR · ${freshness(ws.insider.fetchedAt)}` : "SEC EDGAR — open-market buys/sells only"}
          icon={<Shield size={16} />}
        />
        {insider.length === 0 ? (
          <EmptyState icon={<Shield size={20} />} title="No insider filings cached yet" hint="Open-market Form 4 buys/sells accumulate here as they're filed." />
        ) : (
          <div className="max-h-72 overflow-auto p-2">
            {insider.map((f, i) => {
              const net = f.buyTx - f.sellTx;
              return (
                <div key={`${f.symbol}-${f.owner}-${f.filedAt}-${i}`} className="flex items-center gap-2 border-b border-line/50 px-2 py-1.5 text-[13px] last:border-0">
                  <Chip tone={net > 0 ? "up" : net < 0 ? "down" : "neutral"}>{net > 0 ? "BUY" : net < 0 ? "SELL" : "MIXED"}</Chip>
                  <SymbolButton symbol={f.symbol} scan={scan} onDrilldown={onDrilldown} className="font-semibold text-fg" title={companyTitle(f.symbol, snapshot.symbolMetaBySymbol ?? {})} />
                  <span className="truncate text-muted" title={f.owner}>{f.owner}</span>
                  <span className="ml-auto whitespace-nowrap text-faint">{f.filedAt}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function RatingChip({ score, label }: { score?: number; label: string }) {
  // Mirror the Sentiment chip: green for Buy-ish, red for Sell-ish, neutral for Hold.
  const tone = score === undefined ? "neutral" : score >= 65 ? "up" : score <= 40 ? "down" : "neutral";
  return <Chip tone={tone}>{typeof score === "number" ? `${label} ${score}` : label}</Chip>;
}

/** Map the raw market session to a status label + dot tone (green open, grey closed). */
function marketStatusFor(session?: string): { tone: "up" | "warn" | "neutral"; label: string } {
  switch (session) {
    case "regular":
      return { tone: "up", label: "Market Open" };
    case "pre":
      return { tone: "warn", label: "Pre-market" };
    case "post":
      return { tone: "warn", label: "After-hours" };
    default:
      return { tone: "neutral", label: "Market Closed" };
  }
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
  const realizedGross = mode === "paper" ? perf?.paperRealizedPnl ?? 0 : perf?.liveRealizedPnl ?? 0;
  // Optionally net realized P&L of the estimated tax burden (toggle in Settings → Tax).
  const subtractTax = Boolean(snapshot.policy.taxSettings?.subtractFromResults && snapshot.tax);
  const taxBurden = subtractTax ? snapshot.tax!.estimatedTaxLiability : 0;
  const realized = realizedGross - taxBurden;
  const unrealized = mode === "paper" ? perf?.paperUnrealizedPnl ?? 0 : perf?.liveUnrealizedPnl ?? 0;
  const winRate = mode === "paper" ? perf?.paperWinRate ?? 0 : perf?.liveWinRate ?? 0;
  const avgReturn = mode === "paper" ? perf?.paperAverageReturnPct ?? 0 : perf?.liveAverageReturnPct ?? 0;
  const thesis = (snapshot.thesisScorecard ?? []).map((t) => ({ label: t.thesisTag, pnl: t.totalPnl, winRate: t.winRate, trades: t.trades }));
  const regime = (snapshot.regimeScorecard ?? []).map((r) => ({ label: r.regime, pnl: r.totalPnl, winRate: r.winRate, trades: r.trades }));

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <PanelHeader title="Equity" subtitle={mode === "paper" ? "Paper account" : "Live account"} icon={<TrendingUp size={16} />} />
        <div className="grid grid-cols-2 gap-2 px-4 pt-3 sm:grid-cols-4">
          <StatTile label={subtractTax ? "Realized (after est. tax)" : "Realized"} value={signedMoney(realized)} tone={realized >= 0 ? "up" : "down"} sub={subtractTax ? `−${money(taxBurden)} est. tax` : undefined} title="Profit/loss locked in by closing positions (FIFO matched). Toggle after-tax in Settings → Tax." />
          <StatTile label="Unrealized" value={signedMoney(unrealized)} tone={unrealized >= 0 ? "up" : "down"} title="Paper gain/loss on positions still open, marked to current prices." />
          <StatTile label="Win rate" value={`${winRate.toFixed(0)}%`} title="Share of closed lots that were profitable." />
          <StatTile label="Avg return" value={`${avgReturn.toFixed(2)}%`} tone={avgReturn >= 0 ? "up" : "down"} title="Average percentage return per closed lot." />
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

/* ───────────────────────── Tax view (tab) ───────────────────────── */

function TaxView({
  snapshot,
  symbolMetaBySymbol,
  scan,
  onDrilldown
}: {
  snapshot: DashboardSnapshot;
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
  scan: MarketScan | null;
  onDrilldown: (q: MarketQuote) => void;
}) {
  const tax = snapshot.tax;
  if (!tax) {
    return (
      <Card>
        <PanelHeader title="Tax" icon={<Landmark size={16} />} />
        <EmptyState icon={<Landmark size={20} />} title="No tax data yet" hint="Select an account and run the strategy; realized gains and lots appear here." />
      </Card>
    );
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <PanelHeader
          title={`Tax overview · ${tax.taxYear}`}
          subtitle="Rough estimates only — not tax advice. Consult a CPA."
          icon={<Landmark size={16} />}
          actions={<Chip tone={tax.settings.washSaleGuard ? "up" : "warn"}>Wash-sale guard {tax.settings.washSaleGuard ? "on" : "off"}</Chip>}
        />
        <div className="grid grid-cols-2 gap-2 p-4 pt-3 sm:grid-cols-4">
          <StatTile label="Short-term realized" value={signedMoney(tax.shortTermRealized)} tone={tax.shortTermRealized >= 0 ? "up" : "down"} sub={`taxed ~${tax.settings.shortTermRatePct}% (ordinary)`} />
          <StatTile label="Long-term realized" value={signedMoney(tax.longTermRealized)} tone={tax.longTermRealized >= 0 ? "up" : "down"} sub={`taxed ~${tax.settings.longTermRatePct}%`} />
          <StatTile label="Est. tax liability" value={money(tax.estimatedTaxLiability)} tone="down" sub="this year, on realized gains" />
          <StatTile label="Disallowed (wash sale)" value={money(tax.disallowedWashSaleLoss)} tone={tax.disallowedWashSaleLoss > 0 ? "warn" : "neutral"} sub="losses you can't deduct" />
        </div>
      </Card>

      <Card>
        <PanelHeader title="Wash-sale lockout" subtitle="Rebuying these is blocked 30 days after a loss sale" icon={<Shield size={16} />} />
        <div className="space-y-3 p-4 pt-3">
          {tax.lockedSymbols.length === 0 ? (
            <p className="text-[13px] text-faint">No symbols are currently locked out.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {tax.lockedSymbols.map((s) => (
                <Chip key={s} tone="down">
                  <SymbolButton symbol={s} scan={scan} onDrilldown={onDrilldown} variant="chip" title={companyTitle(s, symbolMetaBySymbol)} />
                </Chip>
              ))}
            </div>
          )}
          {tax.washSales.length > 0 && (
            <div className="space-y-1.5 border-t border-line pt-3">
              <span className="text-xs font-medium text-muted">Wash sales detected this year</span>
              {tax.washSales.slice(0, 6).map((w, i) => (
                <div key={`${w.symbol}-${i}`} className="flex items-center justify-between text-[13px]">
                  <SymbolButton symbol={w.symbol} scan={scan} onDrilldown={onDrilldown} className="font-semibold text-fg" title={companyTitle(w.symbol, symbolMetaBySymbol)} />
                  <span className="tnum text-faint">{new Date(w.soldAt).toLocaleDateString()} · {money(w.disallowedLoss)} disallowed</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Card>
        <PanelHeader title="Tax-loss harvest candidates" subtitle="Unrealized losers that could offset realized gains" icon={<Percent size={16} />} />
        <div className="p-4 pt-3">
          {tax.harvestCandidates.length === 0 ? (
            <p className="text-[13px] text-faint">No harvestable losses right now.</p>
          ) : (
            <table className="w-full text-[13px]">
              <tbody>
                {tax.harvestCandidates.map((h) => (
                  <tr key={h.symbol} className="border-b border-line/50">
                    <td className="py-1.5 font-semibold text-fg"><SymbolButton symbol={h.symbol} scan={scan} onDrilldown={onDrilldown} title={companyTitle(h.symbol, symbolMetaBySymbol)} /></td>
                    <td className="py-1.5 text-right tnum text-muted">{formatShareQuantity(h.quantity, h.symbol)} sh</td>
                    <td className="py-1.5 text-right tnum text-down">{signedMoney(h.unrealizedLoss)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      <Card className="lg:col-span-2">
        <PanelHeader title="Holding period — days to long-term" subtitle="Crossing 1 year flips gains from ordinary to long-term rates" icon={<Hourglass size={16} />} />
        <div className="min-h-0 overflow-auto p-2">
          {tax.openLots.length === 0 ? (
            <EmptyState icon={<Hourglass size={18} />} title="No open lots" />
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase text-faint">
                  <th className="px-2 py-1.5 text-left font-semibold">Symbol</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Qty</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Days held</th>
                  <th className="px-2 py-1.5 text-left font-semibold">Progress to long-term</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {tax.openLots.map((lot, i) => (
                  <tr key={`${lot.symbol}-${i}`} className="border-b border-line/50">
                    <td className="px-2 py-1.5 font-semibold text-fg"><SymbolButton symbol={lot.symbol} scan={scan} onDrilldown={onDrilldown} title={companyTitle(lot.symbol, symbolMetaBySymbol)} /></td>
                    <td className="px-2 py-1.5 text-right tnum text-muted">{formatShareQuantity(lot.quantity, lot.symbol)}</td>
                    <td className="px-2 py-1.5 text-right tnum text-muted">{lot.daysHeld}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="h-1.5 w-32 overflow-hidden rounded-full bg-surface-3/50 backdrop-blur-md">
                          <span className={cn("block h-full rounded-full", lot.isLongTerm ? "bg-up" : "bg-info")} style={{ width: `${Math.min(100, (lot.daysHeld / 365) * 100)}%` }} />
                        </span>
                        <span className="tnum text-[11px] text-faint">{lot.isLongTerm ? "—" : `${lot.daysToLongTerm}d left`}</span>
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Chip tone={lot.isLongTerm ? "up" : "warn"}>{lot.isLongTerm ? "Long-term" : "Short-term"}</Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}

/* ───────────────────────── Strategy view (tab) ───────────────────────── */

function StrategyView({
  snapshot,
  policy,
  updatePolicy,
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
  updatePolicy: (patch: PolicyPatch) => void;
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
        <PanelHeader title="Key parameters" subtitle="Edit inline — applies immediately (same values as Settings → Risk & Limits)" icon={<Shield size={16} />} />
        <div className="grid grid-cols-2 gap-2 p-4 pt-3 text-sm">
          <EditableParam label="Max order" prefix="$" value={policy.maxOrderNotional} onCommit={(v) => updatePolicy({ maxOrderNotional: v })} />
          <EditableParam label="Daily cap" prefix="$" value={policy.maxDailyNotional} onCommit={(v) => updatePolicy({ maxDailyNotional: v })} />
          <EditableParam label="Symbol cap" suffix="%" value={policy.maxSymbolExposurePct} onCommit={(v) => updatePolicy({ maxSymbolExposurePct: v })} />
          <EditableParam label="Proposals/run" value={policy.maxProposalsPerRun} onCommit={(v) => updatePolicy({ maxProposalsPerRun: v })} />
          <EditableParam label="Stop loss" suffix="%" value={policy.riskRules.stopLossPct ?? 0} onCommit={(v) => updatePolicy({ riskRules: { ...policy.riskRules, stopLossPct: v } })} />
          <EditableParam label="Take profit" suffix="%" value={policy.riskRules.takeProfitPct ?? 0} onCommit={(v) => updatePolicy({ riskRules: { ...policy.riskRules, takeProfitPct: v } })} />
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
    <div className="rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2">
      <div className="text-[11px] uppercase text-faint">{label}</div>
      <div className="tnum text-sm text-fg">{value}</div>
    </div>
  );
}

function EditableParam({
  label,
  value,
  prefix,
  suffix,
  onCommit
}: {
  label: string;
  value: number;
  prefix?: string;
  suffix?: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  function commit() {
    const n = Number(draft);
    if (Number.isFinite(n) && n >= 0 && n !== value) onCommit(n);
    else setDraft(String(value));
  }
  return (
    <label className="rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2 focus-within:border-accent">
      <div className="text-[11px] uppercase text-faint">{label}</div>
      <div className="flex items-baseline gap-0.5">
        {prefix && <span className="text-sm text-faint">{prefix}</span>}
        <input
          type="number"
          min={0}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="w-full bg-transparent tnum text-sm text-fg outline-none"
        />
        {suffix && <span className="text-sm text-faint">{suffix}</span>}
      </div>
    </label>
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
        <ul className="space-y-1 rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg p-3 text-[13px] text-muted">
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
                    <span key={t} className="rounded bg-surface-3/50 backdrop-blur-md px-1.5 py-0.5 text-[10px] font-semibold uppercase text-faint">{t}</span>
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
  updatePolicy,
  load
}: {
  snapshot: DashboardSnapshot;
  policy: TradingPolicy;
  allowedCount: number;
  enableBlockedReason?: string;
  remainingNotional: number;
  remainingOrders: number;
  updatePolicy: (patch: PolicyPatch) => void;
  load: () => Promise<void>;
}) {
  type Section = "operate" | "keys" | "risk" | "tax" | "tuning" | "notifications";
  const [section, setSection] = useState<Section>("operate");
  const [sectorCaps, setSectorCaps] = useState(formatSectorCaps(policy.sectorCaps));
  const [draft, setDraft] = useState("");
  const taxSettings = snapshot.tax?.settings ?? policy.taxSettings ?? { washSaleGuard: true, shortTermRatePct: 24, longTermRatePct: 15 };
  const tuning = policy.tuning ?? {};

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
          { id: "keys", label: "API Keys" },
          { id: "risk", label: "Risk & Limits" },
          { id: "tax", label: "Tax" },
          { id: "tuning", label: "Tuning" },
          { id: "notifications", label: "Notifications" }
        ]}
      />

      {section === "operate" && (
        <div className="grid gap-3 sm:grid-cols-2">
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
          <Field label="Holding horizon" hint="How long you plan to hold most new positions — shapes the agent's setups, exits, and tax awareness" className="sm:col-span-2">
            <select className={inputClass} value={policy.holdingHorizon ?? "swing"} onChange={(e) => updatePolicy({ holdingHorizon: e.target.value as TradingPolicy["holdingHorizon"] })}>
              <option value="intraday">Intraday — day trades</option>
              <option value="swing">Days to weeks — swing trades</option>
              <option value="position">Weeks to months — position trades</option>
              <option value="longterm">Months to years — long-term (favors long-term tax treatment)</option>
            </select>
          </Field>
          <Field label="Custom allowlist" hint={`${allowedCount} symbol${allowedCount === 1 ? "" : "s"} allowed`} className="sm:col-span-2">
            <div className="rounded-lg border border-line bg-bg/60 p-2">
              <div className="mb-2 flex flex-wrap gap-1.5">
                {(policy.universe === "sp500" ? [] : policy.allowlist).map((s) => (
                  <button key={s} onClick={() => updatePolicy({ allowlist: policy.allowlist.filter((x) => x !== s) })} className="inline-flex items-center gap-1 rounded-md bg-surface-3/50 backdrop-blur-md px-2 py-0.5 text-xs text-fg">
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

      {section === "keys" && <ApiKeysSection />}

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
          <Field label="Sector caps" hint="e.g. Technology:25, Financials:20" className="sm:col-span-2">
            <input className={inputClass} value={sectorCaps} onChange={(e) => setSectorCaps(e.target.value)} onBlur={() => updatePolicy({ sectorCaps: parseSectorCaps(sectorCaps) })} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-muted sm:col-span-2">
            <input type="checkbox" checked={policy.runDuringExtendedHours} onChange={(e) => updatePolicy({ runDuringExtendedHours: e.target.checked })} />
            Run during extended hours
          </label>
          <p className="rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2 text-[13px] text-muted sm:col-span-2">
            Remaining today: <span className="tnum text-fg">{money(remainingNotional)}</span> notional and <span className="tnum text-fg">{remainingOrders}</span> orders.
          </p>
        </div>
      )}

      {section === "tax" && (
        <div className="space-y-3">
          <p className="rounded-lg border border-info/25 bg-info/10 px-3 py-2 text-[13px] text-muted">
            Estimates only — not tax advice. These settings tune the after-tax signals the agent sees and the wash-sale guardrail.
          </p>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2.5">
            <span>
              <span className="block text-sm font-medium text-fg">Wash-sale guard</span>
              <span className="block text-xs text-faint">Block rebuying a symbol sold at a loss within 30 days (IRC §1091).</span>
            </span>
            <Switch checked={taxSettings.washSaleGuard} onChange={(v) => updatePolicy({ taxSettings: { ...taxSettings, washSaleGuard: v } })} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Short-term rate (%)" value={taxSettings.shortTermRatePct} onCommit={(v) => updatePolicy({ taxSettings: { ...taxSettings, shortTermRatePct: v } })} />
            <NumberField label="Long-term rate (%)" value={taxSettings.longTermRatePct} onCommit={(v) => updatePolicy({ taxSettings: { ...taxSettings, longTermRatePct: v } })} />
          </div>
          <p className="text-xs text-faint">Rates are used only for the rough liability estimate on the Tax tab. Defaults: 24% short-term (ordinary), 15% long-term.</p>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2.5">
            <span>
              <span className="block text-sm font-medium text-fg">Subtract estimated tax from results</span>
              <span className="block text-xs text-faint">Show realized P&amp;L on the Performance tab net of the estimated tax burden.</span>
            </span>
            <Switch checked={Boolean(taxSettings.subtractFromResults)} onChange={(v) => updatePolicy({ taxSettings: { ...taxSettings, subtractFromResults: v } })} />
          </label>
        </div>
      )}

      {section === "tuning" && (
        <div className="space-y-3">
          <p className="rounded-lg border border-info/25 bg-info/10 px-3 py-2 text-[13px] text-muted">
            Advanced learning-loop knobs that are otherwise fixed code defaults. Leave these alone unless you understand the trade-off.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Shrinkage prior (trades)"
              value={tuning.shrinkPrior ?? 5}
              onCommit={(v) => updatePolicy({ tuning: { ...tuning, shrinkPrior: v } })}
            />
            <NumberField
              label="Min lots for weight shift"
              value={tuning.minClosedLotsForWeightShift ?? 20}
              onCommit={(v) => updatePolicy({ tuning: { ...tuning, minClosedLotsForWeightShift: v } })}
            />
            <NumberField
              label="Sizing floor (% of max)"
              value={tuning.sizingFloorPct ?? 10}
              onCommit={(v) => updatePolicy({ tuning: { ...tuning, sizingFloorPct: v } })}
            />
            <NumberField
              label="Sizing ceiling (% of max)"
              value={tuning.sizingCeilingPct ?? 100}
              onCommit={(v) => updatePolicy({ tuning: { ...tuning, sizingCeilingPct: v } })}
            />
            <NumberField
              label="Red-team threshold"
              value={tuning.redTeamConvictionThreshold ?? 80}
              onCommit={(v) => updatePolicy({ tuning: { ...tuning, redTeamConvictionThreshold: v } })}
            />
            <NumberField
              label="Crisis open cap (% NAV)"
              value={tuning.crisisMaxOpeningExposurePct ?? 0}
              onCommit={(v) => updatePolicy({ tuning: { ...tuning, crisisMaxOpeningExposurePct: v } })}
            />
          </div>
          <p className="text-xs text-faint">
            <span className="font-medium text-muted">Shrinkage prior</span> pulls thin-sample win/return stats toward neutral (higher = more skeptical of small samples; default 5).{" "}
            <span className="font-medium text-muted">Min lots for weight shift</span> is how many closed trades must accumulate before the auto-tuner may change factor weights (default 20).
          </p>
          <p className="text-xs text-faint">
            <span className="font-medium text-muted">Red-team threshold</span> sends proposals at or above that confidence score to the adversarial review (default 80).{" "}
            <span className="font-medium text-muted">Crisis open cap</span> blocks new buy/short notional above that portfolio percentage when the deterministic regime is crisis or inverted curve; 0 leaves it off.
          </p>
          <p className="text-xs text-faint">
            Other tunables (scan refresh cadence, congressional/insider lookback windows, scoring sub-score thresholds) are set via environment variables — see <span className="text-muted">docs/phase-9-web-sources.md</span> and <span className="text-muted">src/lib/market.ts</span>.
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
                  <label key={eventType} className="flex items-center gap-2 rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2 text-sm capitalize text-fg">
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
    <div className="rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg p-2.5">
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

function proposalSize(proposal: TradeProposal, estimatedNotional?: number, price?: number): string {
  // Show the estimated total cost AND the share count. The "~" means it's an estimate
  // (fill price can differ). Shares use the app-wide formatter (up to 3 significant
  // figures, trailing zeros stripped — e.g. 0.5, 0.25, 1.5).
  const px = price && price > 0 ? price : proposal.limitPrice && proposal.limitPrice > 0 ? proposal.limitPrice : undefined;
  const cost = proposal.dollarAmount ?? estimatedNotional ?? (proposal.quantity && px ? proposal.quantity * px : undefined);
  const shares = proposal.quantity ?? (cost && px ? cost / px : undefined);
  if (typeof cost === "number" && cost > 0 && typeof shares === "number" && shares > 0) {
    return `~${money(cost)} for ${formatShareQuantity(shares, proposal.symbol)} shares`;
  }
  if (typeof cost === "number" && cost > 0) return `~${money(cost)}`;
  if (typeof shares === "number" && shares > 0) return `~${formatShareQuantity(shares, proposal.symbol)} shares`;
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

type ApiKeyStatus = {
  service: string;
  label: string;
  category: string;
  required: boolean;
  unlocks: string;
  docsUrl?: string;
  envVar?: string;
  configured: boolean;
  source: "user" | "env" | "none";
  updatedAt?: string;
};

function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKeyStatus[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyService, setBusyService] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/keys?userId=local", { cache: "no-store" });
      if (!res.ok) throw new Error(await res.text());
      const body = (await res.json()) as { keys?: ApiKeyStatus[] };
      setKeys(body.keys ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load API key status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  async function saveKey(row: ApiKeyStatus) {
    const value = drafts[row.service]?.trim();
    if (!value) return;
    setBusyService(row.service);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "local", service: row.service, apiKey: value, label: row.label })
      });
      if (!res.ok) throw new Error(await res.text());
      setDrafts((current) => ({ ...current, [row.service]: "" }));
      toast.success(`${row.label} key saved.`);
      await loadKeys();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save API key.");
    } finally {
      setBusyService(null);
    }
  }

  async function clearKey(row: ApiKeyStatus) {
    setBusyService(row.service);
    try {
      const res = await fetch(`/api/keys?userId=local&service=${encodeURIComponent(row.service)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      toast.success(`${row.label} saved key cleared.`);
      await loadKeys();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to clear API key.");
    } finally {
      setBusyService(null);
    }
  }

  const requiredUnset = keys.some((row) => row.required && row.source === "none");

  if (loading) {
    return <EmptyState title="Loading API key status" icon={<RefreshCw size={18} className="animate-spin" />} />;
  }

  return (
    <div className="space-y-3">
      {requiredUnset && (
        <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[13px] text-warn">
          OpenAI is required for model-generated proposals. Without it, the app uses local fallback proposals.
        </p>
      )}
      <div className="grid gap-2">
        {keys.map((row) => {
          const busy = busyService === row.service;
          const sourceLabel = row.source === "user" ? "Set" : row.source === "env" ? "Using env" : "Not set";
          const sourceTone = row.source === "user" ? "up" : row.source === "env" ? "info" : row.required ? "warn" : "neutral";
          const inputType = row.service === "sec_edgar_user_agent" ? "text" : "password";
          return (
            <div key={row.service} className="rounded-lg border border-line bg-surface-2/45 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <KeyRound size={14} className="text-muted" />
                    <span className="font-semibold text-fg">{row.label}</span>
                    <Chip tone={sourceTone}>{sourceLabel}</Chip>
                    {row.required && <Chip tone="warn">Required</Chip>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-faint">
                    <span>{row.category}</span>
                    {row.envVar && <span className="font-mono">{row.envVar}</span>}
                    {row.updatedAt && <span>Saved {new Date(row.updatedAt).toLocaleDateString()}</span>}
                  </div>
                </div>
                {row.docsUrl && (
                  <a className="inline-flex items-center gap-1 text-xs font-medium text-info hover:underline" href={row.docsUrl} target="_blank" rel="noreferrer">
                    Docs <ExternalLink size={12} />
                  </a>
                )}
              </div>
              <p className="mt-2 text-[13px] text-muted">{row.unlocks}</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input
                  type={inputType}
                  value={drafts[row.service] ?? ""}
                  onChange={(e) => setDrafts((current) => ({ ...current, [row.service]: e.target.value }))}
                  placeholder={row.source === "none" ? "Paste key or value" : "Saved value is hidden"}
                  className={cn(inputClass, "min-w-0 flex-1")}
                  autoComplete="off"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => saveKey(row)} disabled={busy || !drafts[row.service]?.trim()}>
                    <Save size={13} /> Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => clearKey(row)} disabled={busy || row.source !== "user"}>
                    <Trash2 size={13} /> Clear
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-faint">
        Yahoo Finance, Senate eFD, Capitol Trades, and FINRA short-volume do not need API keys. Brokerage account credentials live in Accounts, not here.
      </p>
    </div>
  );
}

function IntegrationsSection({ accounts, onSaved }: { accounts: DashboardSnapshot["connectedAccounts"], onSaved: () => Promise<void> }) {
  const [editing, setEditing] = useState<Partial<NonNullable<DashboardSnapshot["connectedAccounts"]>[0]> | null>(null);
  const [busy, setBusy] = useState(false);
  const [mcpHealth, setMcpHealth] = useState<RobinhoodMcpHealth | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);

  const refreshMcpHealth = useCallback(async () => {
    setMcpBusy(true);
    try {
      const res = await fetch("/api/broker/mcp/health", { cache: "no-store" });
      const health = (await res.json()) as RobinhoodMcpHealth;
      setMcpHealth(health);
      if (!res.ok) throw new Error(health.error ?? "Robinhood MCP health check failed.");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Robinhood MCP health check failed.";
      setMcpHealth({
        ok: false,
        configured: false,
        authenticated: false,
        tools: [],
        checkedAt: new Date().toISOString(),
        error: message
      });
      toast.error(message);
    } finally {
      setMcpBusy(false);
    }
  }, []);

  useEffect(() => {
    void refreshMcpHealth();
  }, [refreshMcpHealth]);

  async function save() {
    if (!editing?.broker || !editing?.environment) return;
    setBusy(true);
    try {
      const res = await fetch("/api/connected-accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(editing)
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success("Account saved.");
      setEditing(null);
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save account.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount(id: string) {
    if (!confirm("Remove this connected account?")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/connected-accounts/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      toast.success("Account removed.");
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove account.");
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="space-y-4 rounded-lg border border-line bg-surface-2/30 p-4">
        <h4 className="text-sm font-semibold text-fg">{editing.id ? "Edit Account" : `Add ${editing.broker === "alpaca" ? "Alpaca" : "Robinhood"} Account`}</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Environment">
            <select className={inputClass} value={editing.environment || "paper"} onChange={e => setEditing({ ...editing, environment: e.target.value as any })}>
              <option value="paper">Paper (Simulation)</option>
              <option value="live">Live (Real Money)</option>
            </select>
          </Field>
          <Field label="Label (Optional)">
            <input className={inputClass} value={editing.label || ""} onChange={e => setEditing({ ...editing, label: e.target.value })} placeholder="e.g. My Alpaca IRA" />
          </Field>
          <Field label="Account Number (Optional)">
            <input className={inputClass} value={editing.accountNumber || ""} onChange={e => setEditing({ ...editing, accountNumber: e.target.value })} placeholder="e.g. PA12345" />
          </Field>
          {editing.broker === "alpaca" && (
            <>
              <Field label="API Key">
                <input className={inputClass} value={editing.apiKey || ""} onChange={e => setEditing({ ...editing, apiKey: e.target.value })} placeholder="Required for Alpaca" />
              </Field>
              <Field label="API Secret">
                <input type="password" className={inputClass} value={editing.apiSecret || ""} onChange={e => setEditing({ ...editing, apiSecret: e.target.value })} placeholder="Required for Alpaca" />
              </Field>
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy || !editing.broker}>Save Account</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <RobinhoodMcpStatusCard health={mcpHealth} busy={mcpBusy} onRefresh={refreshMcpHealth} />

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">Connect your brokerage accounts for agentic trading.</p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing({ broker: "alpaca", environment: "paper" })}>
            <Plus size={14} className="mr-1" /> Add Alpaca
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { window.location.href = "/api/auth/robinhood/start"; }}>
            <Plus size={14} className="mr-1" /> Add Robinhood
          </Button>
        </div>
      </div>

      {!accounts?.length ? (
        <div className="rounded-lg border border-line border-dashed p-6 text-center text-sm text-faint">
          No accounts connected. Add an Alpaca or Robinhood account to start trading.
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map(acc => (
            <div key={acc.id} className="flex items-center justify-between rounded-lg border border-line bg-surface/50 p-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-fg">{acc.label || acc.broker}</span>
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${acc.environment === "live" ? "bg-red-500/10 text-red-400" : "bg-emerald-500/10 text-emerald-400"}`}>
                    {acc.environment}
                  </span>
                  {acc.isActive && <span className="rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent">Active</span>}
                </div>
                <div className="mt-1 text-xs text-faint capitalize">
                  {acc.broker} &middot; {acc.accountNumber || "No account number"}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => setEditing(acc)} disabled={busy}>Edit</Button>
                <Button variant="ghost" size="sm" onClick={() => deleteAccount(acc.id)} disabled={busy} className="text-danger hover:bg-danger/10 hover:text-danger">Remove</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RobinhoodMcpStatusCard({
  health,
  busy,
  onRefresh
}: {
  health: RobinhoodMcpHealth | null;
  busy: boolean;
  onRefresh: () => void;
}) {
  const tone: "up" | "down" | "warn" | "neutral" = !health
    ? "neutral"
    : health.ok && health.authenticated
      ? "up"
      : health.adapter === "mock"
        ? "warn"
        : "down";
  const label = !health
    ? "Checking"
    : health.ok && health.authenticated
      ? "Connected"
      : health.adapter === "mock"
        ? "Mock mode"
        : health.authenticated
          ? "Tool check failed"
          : "Not connected";
  const detail = health?.error ?? health?.warning;
  const visibleTools = health?.tools?.slice(0, 8) ?? [];

  return (
    <div className="rounded-lg border border-line bg-surface-2/45 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Wallet size={14} className="text-muted" />
            <span className="font-semibold text-fg">Robinhood MCP</span>
            <Chip tone={tone}>{label}</Chip>
            {health?.transport && <Chip tone="info">{health.transport}</Chip>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-faint">
            {health?.url && <span className="max-w-full truncate font-mono">{health.url}</span>}
            {health?.protocolVersion && <span className="font-mono">MCP {health.protocolVersion}</span>}
            {health?.checkedAt && <span>Checked {new Date(health.checkedAt).toLocaleTimeString()}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={onRefresh} disabled={busy}>
            <RefreshCw size={13} className={cn(busy && "animate-spin")} /> Refresh
          </Button>
          {health && !health.authenticated && health.adapter !== "mock" && (
            <Button size="sm" variant="accentSoft" onClick={() => { window.location.href = "/api/auth/robinhood/start"; }}>
              <ExternalLink size={13} /> Connect OAuth
            </Button>
          )}
        </div>
      </div>
      {detail && (
        <p className={cn("mt-2 text-[13px]", tone === "down" ? "text-down" : "text-muted")}>{detail}</p>
      )}
      {visibleTools.length > 0 && (
        <div className="mt-3 rounded-md border border-line/70 bg-bg/35 px-3 py-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">Available tools</div>
          <div className="mt-1 text-[12px] text-muted">
            {visibleTools.join(", ")}
            {(health?.tools.length ?? 0) > visibleTools.length && `, +${(health?.tools.length ?? 0) - visibleTools.length} more`}
          </div>
        </div>
      )}
    </div>
  );
}
