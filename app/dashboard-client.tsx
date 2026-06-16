"use client";

import { AlertTriangle, CheckCircle, Pause, Play, RefreshCw, RotateCcw, Shield, X, XCircle, Zap, Settings, LayoutDashboard } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { DEFAULT_STRATEGY_PROMPT } from "@/lib/defaults";
import { cellTitle, companyTitle, enrichPositionsForDisplay, formatShareQuantity, quoteTitle, ratingTitle, scanQuoteAsOf, sentimentTitle } from "@/lib/dashboard-ui";
import type { EnrichedPosition } from "@/lib/dashboard-ui";
import { SP500_SYMBOLS } from "@/lib/sp500";
import type { EquityPosition, FillEvent, MarketQuote, NotificationSettings, StrategyTuningProposal, TradingPolicy, TradeProposal } from "@/lib/types";
import type { DashboardSnapshot, UnifiedActivityGroup } from "./dashboard-types";
import {
  AllocationDonut,
  Metric,
  NumberField,
  NotificationPanel,
  PerformancePanel,
  ScoringWeightsEditor,
  SymbolTagInput,
  compactMoney,
  compactNum,
  formatPct,
  money,
  signedMoney
} from "./dashboard-widgets";

type SortDir = "asc" | "desc";
type PolicyPatch = Partial<TradingPolicy> & { strategyPrompt?: string };
type WorkspaceTab = "decision" | "market" | "performance" | "strategy";
type InspectorTab = "operate" | "risk" | "profile";
type BottomTab = "activity" | "runs" | "notifications";

export function DashboardClient({ initialSnapshot }: { initialSnapshot: DashboardSnapshot }) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(initialSnapshot);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [alertMessage, setAlertMessage] = useState<{ title: string; body: string; type: "error" | "warning" | "success" } | null>(null);
  const [newProfileName, setNewProfileName] = useState("");
  const [sectorCapsDraft, setSectorCapsDraft] = useState(formatSectorCaps(initialSnapshot.policy.sectorCaps));
  const promptSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showNotionalSettings, setShowNotionalSettings] = useState(false);
  const [tempMaxDailyNotional, setTempMaxDailyNotional] = useState(initialSnapshot.policy.maxDailyNotional);
  const [tempMaxDailyOrders, setTempMaxDailyOrders] = useState(initialSnapshot.policy.maxDailyOrders);
  const [showKillSwitchConfirm, setShowKillSwitchConfirm] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("decision");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("operate");
  const [bottomTab, setBottomTab] = useState<BottomTab>("activity");
  const [showStrategyStudio, setShowStrategyStudio] = useState(false);
  const [strategyTuning, setStrategyTuning] = useState<StrategyTuningProposal | null>(null);
  const [tuningBusy, setTuningBusy] = useState(false);
  const [tuningError, setTuningError] = useState("");

  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [showLeftRail, setShowLeftRail] = useState(true);
  const [showCenterWorkspace, setShowCenterWorkspace] = useState(true);
  const [showRightInspector, setShowRightInspector] = useState(true);
  const [showBottomDrawer, setShowBottomDrawer] = useState(true);

  // Close dropdown when clicking outside
  const layoutMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (layoutMenuRef.current && !layoutMenuRef.current.contains(event.target as Node)) {
        setLayoutMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    setSectorCapsDraft(formatSectorCaps(snapshot.policy.sectorCaps));
  }, [snapshot.policy.sectorCaps]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void load({ quiet: true });
    }, 30_000);
    return () => clearInterval(interval);
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
        const reasonsMsg = body.reasons?.map(r => `• ${r}`).join("\n") ?? "No reasons provided.";
        setAlertMessage({
          title: "Proposal Blocked by Policy Check",
          body: `The following rules blocked this order:\n\n${reasonsMsg}`,
          type: "warning"
        });
        setResult(`Result: blocked - ${body.reasons?.join(", ") ?? ""}`);
      } else {
        setResult(
          body.status === "placed"
            ? `Order placed${body.orderId ? `: ${body.orderId}` : ""}.`
            : body.status === "paper"
              ? "Proposal executed in Paper mode."
              : `Result: ${body.status}${body.reasons ? ` - ${body.reasons.join(", ")}` : ""}`
        );
      }
      // Only refresh dashboard if the proposal succeeded (placed or paper); otherwise keep it in the list for editing
      if (body.status === "placed" || body.status === "paper") {
        await load({ quiet: true });
      }
      setError("");
    } catch (approvalError) {
      const errMsg = approvalError instanceof Error ? approvalError.message : "Proposal approval failed.";
      setError(errMsg);
      setAlertMessage({
        title: "Execution Error",
        body: `Failed to approve proposal:\n${errMsg}`,
        type: "error"
      });
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
      const errMsg = rejectError instanceof Error ? rejectError.message : "Proposal rejection failed.";
      setError(errMsg);
      setAlertMessage({
        title: "Rejection Error",
        body: `Failed to reject proposal:\n${errMsg}`,
        type: "error"
      });
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

  function editStrategyPrompt(value: string) {
    setSnapshot((current) => ({ ...current, strategyPrompt: value }));
    if (promptSaveTimer.current) clearTimeout(promptSaveTimer.current);
    promptSaveTimer.current = setTimeout(() => saveStrategyPrompt(value), 800);
  }

  return (
    <main className="cockpit-shell">
      <header className="cockpit-command">
        <div className="cockpit-brand">
          <p className="eyebrow">Local-only trading control</p>
          <h1>Agentic Trading Cockpit</h1>
          <span>{snapshot.marketSession ? `Market ${snapshot.marketSession}` : "Market session unknown"}</span>
        </div>
        <div className="command-strip" aria-label="Account status">
          <StatusTile label="Mode" value={policy.paperMode ? "Paper" : "Live"} tone={policy.paperMode ? "info" : "danger"} />
          <StatusTile label="Portfolio" value={money(snapshot.portfolio?.totalMarketValue)} />
          <StatusTile label="Buying Power" value={money(snapshot.portfolio?.buyingPower)} />
          <StatusTile label="Autonomy" value={policy.enabled ? "Enabled" : "Paused"} tone={policy.enabled ? "success" : "muted"} />
          <StatusTile label="Daily Risk" value={`${dailyNotionalPct}%`} title={`${money(dailyStats.notional)} used of ${money(policy.maxDailyNotional)}`} />
          <StatusTile label="Allowed" value={policy.universe === "sp500" ? "S&P 500" : `${allowedCount}`} />
        </div>
        <div className="command-actions">
          <div ref={layoutMenuRef} style={{ position: "relative" }}>
            <button className="ghost sm" onClick={() => setLayoutMenuOpen(!layoutMenuOpen)}>
              <LayoutDashboard size={14} />
              Layout
            </button>
            {layoutMenuOpen && (
              <div style={{ position: "absolute", top: "100%", right: 0, marginTop: "8px", background: "white", border: "1px solid var(--line)", borderRadius: "8px", padding: "8px", zIndex: 100, minWidth: "180px", boxShadow: "var(--shadow)", display: "grid", gap: "8px" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", padding: "4px", margin: 0, cursor: "pointer", color: showLeftRail ? "var(--text)" : "var(--muted)", fontWeight: "normal" }}>
                  <input type="checkbox" checked={showLeftRail} onChange={(e) => setShowLeftRail(e.target.checked)} />
                  Left Rail
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", padding: "4px", margin: 0, cursor: "pointer", color: showCenterWorkspace ? "var(--text)" : "var(--muted)", fontWeight: "normal" }}>
                  <input type="checkbox" checked={showCenterWorkspace} onChange={(e) => setShowCenterWorkspace(e.target.checked)} />
                  Center Workspace
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", padding: "4px", margin: 0, cursor: "pointer", color: showRightInspector ? "var(--text)" : "var(--muted)", fontWeight: "normal" }}>
                  <input type="checkbox" checked={showRightInspector} onChange={(e) => setShowRightInspector(e.target.checked)} />
                  Right Inspector
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", padding: "4px", margin: 0, cursor: "pointer", color: showBottomDrawer ? "var(--text)" : "var(--muted)", fontWeight: "normal" }}>
                  <input type="checkbox" checked={showBottomDrawer} onChange={(e) => setShowBottomDrawer(e.target.checked)} />
                  Bottom Drawer
                </label>
              </div>
            )}
          </div>
          <button className="ghost sm" onClick={() => load()} disabled={busy}>
            <RefreshCw size={14} />
            Refresh
          </button>
          <button className="ghost sm" onClick={() => setShowStrategyStudio(true)}>
            <Settings size={14} />
            Strategy Studio
          </button>
          <button className="sm" onClick={runStrategy} disabled={busy}>
            <Zap size={14} />
            Run Once
          </button>
          <button className={policy.killSwitch ? "danger" : ""} onClick={() => setShowKillSwitchConfirm(true)}>
            {policy.killSwitch ? <Play size={16} /> : <X size={16} />}
            Kill Switch
          </button>
        </div>
      </header>

      {(error || result) && (
        <section className="cockpit-alerts">
          {error && (
            <p className="warning">
              <AlertTriangle size={16} /> {error}
            </p>
          )}
          {result && <p className="result">{result}</p>}
        </section>
      )}

      {(showLeftRail || showCenterWorkspace || showRightInspector || showBottomDrawer) && (
        <PanelGroup orientation="vertical">
          {(showLeftRail || showCenterWorkspace || showRightInspector) && (
            <Panel defaultSize={showBottomDrawer ? 75 : 100} minSize={20}>
              <PanelGroup orientation="horizontal" className="cockpit-grid">
                {showLeftRail && (
                  <Panel defaultSize={20} minSize={10}>
                    <aside className="cockpit-rail">
                      <div className="rail-card rail-summary">
                        <span>Today</span>
                        <strong>{dailyStats.orderCount} / {policy.maxDailyOrders} orders</strong>
                        <button className="ghost sm" onClick={() => setShowNotionalSettings(true)}>
                          Edit daily limits
                        </button>
                      </div>
                      <PositionsTable positions={snapshot.positions} portfolio={snapshot.portfolio} symbolMetaBySymbol={symbolMetaBySymbol} />
                      {snapshot.pendingProposals.length > 0 ? (
                        <PendingProposals proposals={snapshot.pendingProposals} symbolMetaBySymbol={symbolMetaBySymbol} busy={busy} approve={approveProposal} reject={rejectProposal} />
                      ) : (
                        <OrdersPanel orders={snapshot.orders} symbolMetaBySymbol={symbolMetaBySymbol} />
                      )}
                    </aside>
                  </Panel>
                )}
                {showLeftRail && (showCenterWorkspace || showRightInspector) && (
                  <PanelResizeHandle className="panel-resize-handle-horizontal" />
                )}
                {showCenterWorkspace && (
                  <Panel defaultSize={55} minSize={20}>
                    <section className="cockpit-workbench">
                      <TabBar
                        tabs={[
                          { id: "decision", label: "Decision" },
                          { id: "market", label: "Market Scan" },
                          { id: "performance", label: "Performance" },
                          { id: "strategy", label: "Strategy" }
                        ]}
                        active={workspaceTab}
                        onSelect={(tab) => setWorkspaceTab(tab)}
                      />
                      <div className="workspace-pane">
                        {workspaceTab === "decision" && (
                          <>
                            <LatestDecision decision={snapshot.latestStrategyRun} symbolMetaBySymbol={symbolMetaBySymbol} />
                            {snapshot.policy.strategyAuthority === "propose" && snapshot.pendingProposals.length > 0 && (
                              <PendingProposals proposals={snapshot.pendingProposals} symbolMetaBySymbol={symbolMetaBySymbol} busy={busy} approve={approveProposal} reject={rejectProposal} />
                            )}
                          </>
                        )}
                        {workspaceTab === "market" && <MarketScanPanel decision={snapshot.latestStrategyRun} />}
                        {workspaceTab === "performance" && (
                          <div className="workspace-stack">
                            <PerformancePanel performance={snapshot.performance} mode={mode} />
                            <section className="panel">
                              <div className="panel-head">
                                <h2>Allocation{mode === "paper" ? " (Paper Mode)" : ""}</h2>
                              </div>
                              <AllocationDonut positions={snapshot.positions} portfolio={snapshot.portfolio} mode={mode} />
                            </section>
                          </div>
                        )}
                        {workspaceTab === "strategy" && (
                          <StrategyStudioPanel
                            snapshot={snapshot}
                            policy={policy}
                            strategyTuning={strategyTuning}
                            tuningBusy={tuningBusy}
                            tuningError={tuningError}
                            editStrategyPrompt={editStrategyPrompt}
                            resetStrategyPrompt={() => {
                              setSnapshot((current) => ({ ...current, strategyPrompt: DEFAULT_STRATEGY_PROMPT }));
                              void saveStrategyPrompt(DEFAULT_STRATEGY_PROMPT);
                            }}
                            requestStrategyTuning={requestStrategyTuning}
                            applyStrategyTuning={applyStrategyTuning}
                            updatePolicy={updatePolicy}
                          />
                        )}
                      </div>
                    </section>
                  </Panel>
                )}
                {showCenterWorkspace && showRightInspector && (
                  <PanelResizeHandle className="panel-resize-handle-horizontal" />
                )}
                {showRightInspector && (
                  <Panel defaultSize={25} minSize={10}>
                    <aside className="cockpit-inspector">
                      <TabBar
                        tabs={[
                          { id: "operate", label: "Operate" },
                          { id: "risk", label: "Risk" },
                          { id: "profile", label: "Profile" }
                        ]}
                        active={inspectorTab}
                        onSelect={(tab) => setInspectorTab(tab)}
                      />
                      <div className="inspector-pane">
                        {inspectorTab === "operate" && (
                          <ControlsPanel
                            snapshot={snapshot}
                            policy={policy}
                            allowedCount={allowedCount}
                            enableBlockedReason={enableBlockedReason}
                            busy={busy}
                            updatePolicy={updatePolicy}
                            runStrategy={runStrategy}
                          />
                        )}
                        {inspectorTab === "risk" && (
                          <RiskPanel
                            policy={policy}
                            remainingNotional={remainingNotional}
                            remainingOrders={remainingOrders}
                            sectorCapsDraft={sectorCapsDraft}
                            setSectorCapsDraft={setSectorCapsDraft}
                            updatePolicy={updatePolicy}
                          />
                        )}
                        {inspectorTab === "profile" && (
                          <ProfilePanel
                            snapshot={snapshot}
                            newProfileName={newProfileName}
                            setNewProfileName={setNewProfileName}
                            activateProfile={activateProfile}
                            createProfile={createProfile}
                          />
                        )}
                      </div>
                    </aside>
                  </Panel>
                )}
              </PanelGroup>
            </Panel>
          )}
          {(showLeftRail || showCenterWorkspace || showRightInspector) && showBottomDrawer && (
            <PanelResizeHandle className="panel-resize-handle-vertical" />
          )}
          {showBottomDrawer && (
            <Panel defaultSize={25} minSize={10}>
              <section className="cockpit-bottom">
                <TabBar
                  tabs={[
                    { id: "activity", label: "Activity" },
                    { id: "runs", label: "Runs" },
                    { id: "notifications", label: "Notifications" }
                  ]}
                  active={bottomTab}
                  onSelect={(tab) => setBottomTab(tab)}
                />
                <div className="bottom-pane">
                  {bottomTab === "activity" && (
                    <UnifiedActivityFeedPanel
                      unifiedFeed={snapshot.unifiedFeed}
                      configured={snapshot.notificationStatus.configured}
                      symbolMetaBySymbol={symbolMetaBySymbol}
                      policy={snapshot.policy}
                      updatePolicy={updatePolicy}
                    />
                  )}
                  {bottomTab === "runs" && <RunHistory runs={snapshot.strategyRuns} />}
                  {bottomTab === "notifications" && (
                    <NotificationPanel
              notifications={snapshot.notifications}
              configured={snapshot.notificationStatus.configured}
              symbolMetaBySymbol={symbolMetaBySymbol}
              mode={mode}
            />
          )}
              </div>
            </section>
          </Panel>
        )}
        </PanelGroup>
      )}

      {showNotionalSettings && (
        <div className="alert-modal-overlay">
          <div className="alert-modal">
            <div className="alert-modal-header">
              <h3>Edit Daily Limits</h3>
              <button className="close-btn" onClick={() => setShowNotionalSettings(false)}>×</button>
            </div>
            <div className="alert-modal-body modal-form">
              <RangeNumberField label="Max Daily Notional" value={tempMaxDailyNotional} min={10} max={10000} step={10} onCommit={setTempMaxDailyNotional} />
              <RangeNumberField label="Max Daily Orders" value={tempMaxDailyOrders} min={1} max={100} step={1} onCommit={setTempMaxDailyOrders} />
            </div>
            <div className="alert-modal-actions">
              <button onClick={() => { void updatePolicy({ maxDailyNotional: tempMaxDailyNotional, maxDailyOrders: tempMaxDailyOrders }); setShowNotionalSettings(false); }}>Save</button>
              <button className="ghost" onClick={() => setShowNotionalSettings(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {showStrategyStudio && (
        <div className="alert-modal-overlay">
          <div className="strategy-modal">
            <div className="alert-modal-header">
              <h3>Strategy Studio</h3>
              <button className="close-btn" onClick={() => setShowStrategyStudio(false)}>×</button>
            </div>
            <div className="strategy-modal-body">
              <StrategyStudioPanel
                snapshot={snapshot}
                policy={policy}
                strategyTuning={strategyTuning}
                tuningBusy={tuningBusy}
                tuningError={tuningError}
                editStrategyPrompt={editStrategyPrompt}
                resetStrategyPrompt={() => {
                  setSnapshot((current) => ({ ...current, strategyPrompt: DEFAULT_STRATEGY_PROMPT }));
                  void saveStrategyPrompt(DEFAULT_STRATEGY_PROMPT);
                }}
                requestStrategyTuning={requestStrategyTuning}
                applyStrategyTuning={applyStrategyTuning}
                updatePolicy={updatePolicy}
              />
            </div>
          </div>
        </div>
      )}

      {alertMessage && (
        <div className="alert-modal-overlay">
          <div className="alert-modal">
            <div className={`alert-modal-header ${alertMessage.type}`}>
              <h3>{alertMessage.title}</h3>
              <button className="close-btn" onClick={() => setAlertMessage(null)}>×</button>
            </div>
            <div className="alert-modal-body">
              {alertMessage.body.split("\n").map((line, idx) => (
                <p key={idx}>{line}</p>
              ))}
            </div>
            <div className="alert-modal-actions">
              <button onClick={() => setAlertMessage(null)}>Dismiss</button>
            </div>
          </div>
        </div>
      )}

      {showKillSwitchConfirm && (
        <div className="alert-modal-overlay">
          <div className="alert-modal" style={{ maxWidth: "420px" }}>
            <div className={`alert-modal-header ${policy.killSwitch ? "success" : "warning"}`}>
              <h3>{policy.killSwitch ? "Deactivate Kill Switch?" : "Activate Kill Switch?"}</h3>
              <button className="close-btn" onClick={() => setShowKillSwitchConfirm(false)}>×</button>
            </div>
            <div className="alert-modal-body" style={{ textAlign: "left" }}>
              <p style={{ marginBottom: "12px", color: "var(--text)" }}>
                {policy.killSwitch
                  ? "Are you sure you want to deactivate the Kill Switch? This will resume automated trading operations."
                  : "Are you sure you want to activate the Kill Switch? This will immediately pause all automated trading runs and block any new order proposals."}
              </p>
            </div>
            <div className="alert-modal-actions">
              <button
                className={policy.killSwitch ? "approve" : "danger"}
                onClick={async () => {
                  await updatePolicy({ killSwitch: !policy.killSwitch });
                  setShowKillSwitchConfirm(false);
                }}
              >
                Confirm
              </button>
              <button className="ghost" onClick={() => setShowKillSwitchConfirm(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function StatusTile({
  label,
  value,
  tone = "default",
  title
}: {
  label: string;
  value: string;
  tone?: "default" | "success" | "danger" | "info" | "muted";
  title?: string;
}) {
  return (
    <div className={`status-tile status-tile-${tone}`} title={title ?? value}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TabBar<T extends string>({
  tabs,
  active,
  onSelect
}: {
  tabs: Array<{ id: T; label: string }>;
  active: T;
  onSelect: (id: T) => void;
}) {
  return (
    <div className="tab-bar">
      {tabs.map((tab) => (
        <button key={tab.id} className={active === tab.id ? "tab-active" : ""} onClick={() => onSelect(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function ControlsPanel({
  snapshot,
  policy,
  allowedCount,
  enableBlockedReason,
  busy,
  updatePolicy,
  runStrategy
}: {
  snapshot: DashboardSnapshot;
  policy: TradingPolicy;
  allowedCount: number;
  enableBlockedReason?: string;
  busy: boolean;
  updatePolicy: (patch: PolicyPatch) => void;
  runStrategy: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Operate</h2>
        <Shield size={18} />
      </div>
      <label>
        Account
        <select value={policy.accountNumber ?? ""} onChange={(event) => updatePolicy({ accountNumber: event.target.value })}>
          <option value="">Select account</option>
          {snapshot.accounts.map((account) => (
            <option key={account.accountNumber} value={account.accountNumber}>
              {account.label} {account.agenticAllowed ? "" : "(not agentic)"}
            </option>
          ))}
        </select>
      </label>
      <label>
        Allowed Universe
        <select value={policy.universe} onChange={(event) => updatePolicy({ universe: event.target.value as TradingPolicy["universe"] })}>
          <option value="custom">Custom allowlist</option>
          <option value="sp500">S&amp;P 500 ({SP500_SYMBOLS.length} symbols)</option>
        </select>
      </label>
      <label>
        Strategy Authority
        <select value={policy.strategyAuthority} onChange={(event) => updatePolicy({ strategyAuthority: event.target.value as TradingPolicy["strategyAuthority"] })}>
          <option value="propose">LLM proposes - you approve</option>
          <option value="decide">LLM decides - runs autonomously</option>
        </select>
      </label>
      <label>
        Custom Allowlist
        <SymbolTagInput
          disabled={policy.universe === "sp500"}
          values={policy.universe === "sp500" ? [] : policy.allowlist}
          onCommit={(allowlist) => updatePolicy({ allowlist })}
        />
      </label>
      <p className="subtle">{allowedCount} symbol{allowedCount === 1 ? "" : "s"} currently allowed.</p>
      <div className="toggle-row">
        <button
          disabled={!policy.enabled && Boolean(enableBlockedReason)}
          title={!policy.enabled ? enableBlockedReason : undefined}
          onClick={() => updatePolicy({ enabled: !policy.enabled, killSwitch: false })}
        >
          {policy.enabled ? <Pause size={18} /> : <Play size={18} />}
          {policy.enabled ? "Pause" : "Enable"}
        </button>
        <button className="ghost" onClick={() => updatePolicy({ paperMode: !policy.paperMode })}>
          {policy.paperMode ? "Switch Live" : "Switch Paper"}
        </button>
        <button onClick={runStrategy} disabled={busy}>
          <Zap size={18} />
          Run
        </button>
      </div>
      {policy.killSwitch && (
        <p className="warning">
          <AlertTriangle size={16} /> Kill switch is active. New orders are blocked.
        </p>
      )}
      {!policy.enabled && enableBlockedReason && (
        <p className="warning">
          <AlertTriangle size={16} /> {enableBlockedReason}
        </p>
      )}
    </section>
  );
}

function StrategyStudioPanel({
  snapshot,
  policy,
  strategyTuning,
  tuningBusy,
  tuningError,
  editStrategyPrompt,
  resetStrategyPrompt,
  requestStrategyTuning,
  applyStrategyTuning,
  updatePolicy
}: {
  snapshot: DashboardSnapshot;
  policy: TradingPolicy;
  strategyTuning: StrategyTuningProposal | null;
  tuningBusy: boolean;
  tuningError: string;
  editStrategyPrompt: (value: string) => void;
  resetStrategyPrompt: () => void;
  requestStrategyTuning: () => void;
  applyStrategyTuning: () => void;
  updatePolicy: (patch: PolicyPatch) => void;
}) {
  return (
    <div className="strategy-studio-grid">
      <section className="panel strategy-editor">
        <div className="panel-head">
          <div>
            <h2>Strategy Prompt</h2>
            <span className="subtle-text">Autosaves after editing. LLM tuning suggestions require manual apply.</span>
          </div>
          <button className="ghost sm" onClick={resetStrategyPrompt}>
            <RotateCcw size={14} />
            Reset
          </button>
        </div>
        <textarea value={snapshot.strategyPrompt} onChange={(event) => editStrategyPrompt(event.target.value)} />
      </section>

      <section className="panel strategy-controls">
        <div className="panel-head">
          <div>
            <h2>Strategy Options</h2>
            <span className="subtle-text">Fast sliders for the controls the LLM is allowed to suggest changing.</span>
          </div>
        </div>
        <div className="range-grid">
          <RangeNumberField label="Max order $" value={policy.maxOrderNotional} min={1} max={1000} step={1} onCommit={(value) => updatePolicy({ maxOrderNotional: value })} />
          <RangeNumberField label="Daily $" value={policy.maxDailyNotional} min={10} max={10000} step={10} onCommit={(value) => updatePolicy({ maxDailyNotional: value })} />
          <RangeNumberField label="Symbol cap %" value={policy.maxSymbolExposurePct} min={1} max={100} step={1} onCommit={(value) => updatePolicy({ maxSymbolExposurePct: value })} />
          <RangeNumberField label="Proposals/run" value={policy.maxProposalsPerRun} min={1} max={10} step={1} onCommit={(value) => updatePolicy({ maxProposalsPerRun: Math.round(value) })} />
          <RangeNumberField label="Cadence min" value={policy.runCadenceMinutes} min={1} max={240} step={1} onCommit={(value) => updatePolicy({ runCadenceMinutes: Math.round(value) })} />
          <RangeNumberField label="Stop loss %" value={policy.riskRules.stopLossPct ?? 0} min={0} max={50} step={0.5} onCommit={(value) => updatePolicy({ riskRules: { ...policy.riskRules, stopLossPct: value } })} />
          <RangeNumberField label="Take profit %" value={policy.riskRules.takeProfitPct ?? 0} min={0} max={100} step={0.5} onCommit={(value) => updatePolicy({ riskRules: { ...policy.riskRules, takeProfitPct: value } })} />
        </div>
        <div>
          <h3 className="section-label">Scoring Weights</h3>
          <ScoringWeightsEditor weights={policy.scoringWeights} onCommit={(scoringWeights) => updatePolicy({ scoringWeights })} />
        </div>
      </section>

      <section className="panel strategy-review">
        <div className="panel-head">
          <div>
            <h2>LLM Strategy Review</h2>
            <span className="subtle-text">Reviews past performance, latest scan context, macro data, and the current prompt.</span>
          </div>
          <button onClick={requestStrategyTuning} disabled={tuningBusy}>
            <Zap size={16} />
            {tuningBusy ? "Reviewing" : "Review Strategy"}
          </button>
        </div>
        {tuningError && (
          <p className="warning">
            <AlertTriangle size={16} /> {tuningError}
          </p>
        )}
        {strategyTuning ? (
          <StrategyTuningCard proposal={strategyTuning} onApply={applyStrategyTuning} />
        ) : (
          <p className="subtle">No tuning proposal yet. Run a review to get suggested prompt, scoring, and risk changes.</p>
        )}
      </section>
    </div>
  );
}

function StrategyTuningCard({ proposal, onApply }: { proposal: StrategyTuningProposal; onApply: () => void }) {
  const patchItems = summarizeTuningPatch(proposal);
  return (
    <div className="tuning-card">
      <div className="tuning-head">
        <span className={`status-badge ${proposal.generatedBy === "llm" ? "status-completed" : "status-running"}`}>
          {proposal.generatedBy === "llm" ? "LLM review" : "local rules review"}
        </span>
        <span className="subtle-text">Confidence {proposal.confidenceScore.toFixed(0)}%</span>
      </div>
      <strong>{proposal.summary}</strong>
      <p>{proposal.performanceReadout}</p>
      <p>{proposal.marketContext}</p>
      <p>{proposal.rationale}</p>
      {patchItems.length > 0 ? (
        <ul className="patch-list">
          {patchItems.map((item) => <li key={item}>{item}</li>)}
        </ul>
      ) : (
        <p className="subtle">No concrete patch fields were returned.</p>
      )}
      {proposal.cautions.length > 0 && (
        <div className="caution-list">
          {proposal.cautions.map((caution) => <span key={caution}>{caution}</span>)}
        </div>
      )}
      <button className="approve" disabled={patchItems.length === 0} onClick={onApply}>
        <CheckCircle size={15} />
        Apply Reviewed Changes
      </button>
    </div>
  );
}

function MarketScanPanel({ decision }: { decision?: DashboardSnapshot["latestStrategyRun"] }) {
  const scan = decision?.marketScan;
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Market Scan</h2>
          <span className="subtle-text">
            {scan
              ? `${scan.returnedQuotes} quotes from ${formatSources(scan.source)}`
              : "Run the strategy once to populate market context."}
          </span>
        </div>
      </div>
      {!scan ? (
        <p className="subtle">No market scan has been captured yet.</p>
      ) : (
        <>
          <div className="scan-kpis">
            <Metric label="Scanned" value={String(scan.scannedSymbols)} />
            <Metric label="Returned" value={String(scan.returnedQuotes)} />
            <Metric label="Generated" value={new Date(scan.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} />
            <Metric label="Cache" value={scan.cached ? "cached" : "fresh"} />
          </div>
          {scan.warnings.length > 0 && <p className="warning"><AlertTriangle size={16} /> {scan.warnings.join("; ")}</p>}
          <ScanTable candidates={scan.topCandidates} />
        </>
      )}
    </section>
  );
}

function OrdersPanel({
  orders,
  symbolMetaBySymbol
}: {
  orders: DashboardSnapshot["orders"];
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
}) {
  return (
    <section className="panel run-history">
      <div className="panel-head">
        <h2>Recent Orders</h2>
      </div>
      {orders.length === 0 ? (
        <p className="subtle">No broker orders returned.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Side</th>
              <th>State</th>
              <th>Qty/$</th>
            </tr>
          </thead>
          <tbody>
            {orders.slice(0, 12).map((order) => (
              <tr key={order.id}>
                <td><strong title={companyTitle(order.symbol, symbolMetaBySymbol)}>{order.symbol}</strong></td>
                <td className={order.side === "buy" || order.side === "cover" ? "pnl-pos" : "pnl-neg"}>{order.side}</td>
                <td>{order.state}</td>
                <td>{order.dollarAmount ? money(order.dollarAmount) : order.quantity ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function RangeNumberField({
  label,
  value,
  min,
  max,
  step,
  onCommit
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const draftNumber = Number(draft);
  const safeValue = Number.isFinite(draftNumber) ? Math.max(min, Math.min(max, draftNumber)) : value;

  function commit(nextValue = safeValue) {
    const normalized = Math.max(min, Math.min(max, nextValue));
    setDraft(String(normalized));
    if (normalized !== value) onCommit(normalized);
  }

  return (
    <label className="range-field">
      <span>{label}</span>
      <strong>{Number.isInteger(safeValue) ? safeValue : safeValue.toFixed(1)}</strong>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={safeValue}
        onChange={(event) => setDraft(event.target.value)}
        onMouseUp={() => commit()}
        onTouchEnd={() => commit()}
        onKeyUp={(event) => {
          if (event.key === "Enter" || event.key.startsWith("Arrow")) commit();
        }}
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </label>
  );
}

function summarizeTuningPatch(proposal: StrategyTuningProposal): string[] {
  const patch = proposal.proposedPatch;
  const items: string[] = [];
  if (patch.prompt) items.push("Prompt rewrite proposed");
  for (const [key, value] of Object.entries(patch.scoringWeights ?? {})) {
    items.push(`Weight ${labelize(key)} -> ${formatPatchValue(value)}`);
  }
  const policy = patch.policy ?? {};
  for (const [key, value] of Object.entries(policy)) {
    if (key === "riskRules" || value === undefined) continue;
    items.push(`${labelize(key)} -> ${formatPatchValue(value)}`);
  }
  for (const [key, value] of Object.entries(policy.riskRules ?? {})) {
    items.push(`${labelize(key)} -> ${formatPatchValue(value)}`);
  }
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
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function RiskPanel({
  policy,
  remainingNotional,
  remainingOrders,
  sectorCapsDraft,
  setSectorCapsDraft,
  updatePolicy
}: {
  policy: TradingPolicy;
  remainingNotional: number;
  remainingOrders: number;
  sectorCapsDraft: string;
  setSectorCapsDraft: (value: string) => void;
  updatePolicy: (patch: PolicyPatch) => void;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Risk Envelope</h2>
      </div>
      <div className="risk-inputs">
        <NumberField label="Max order ($)" value={policy.maxOrderNotional} onCommit={(value) => updatePolicy({ maxOrderNotional: value })} />
        <NumberField label="Max symbol (%)" value={policy.maxSymbolExposurePct} onCommit={(value) => updatePolicy({ maxSymbolExposurePct: value })} />
      </div>
      <div className="risk-inputs">
        <NumberField label="Max proposals/run" value={policy.maxProposalsPerRun} onCommit={(value) => updatePolicy({ maxProposalsPerRun: value })} />
        <NumberField label="Cadence (min)" value={policy.runCadenceMinutes} onCommit={(value) => updatePolicy({ runCadenceMinutes: Math.max(1, Math.round(value)) })} />
        <NumberField label="Stop loss (%)" value={policy.riskRules.stopLossPct} onCommit={(value) => updatePolicy({ riskRules: { ...policy.riskRules, stopLossPct: value } })} />
        <NumberField label="Take profit (%)" value={policy.riskRules.takeProfitPct} onCommit={(value) => updatePolicy({ riskRules: { ...policy.riskRules, takeProfitPct: value } })} />
      </div>
      <div className="risk-inputs">
        <NumberField label="Paper start ($)" value={policy.paperStartingCash} onCommit={(value) => updatePolicy({ paperStartingCash: Math.max(0, Math.round(value)) })} />
      </div>
      <label>
        Sector caps
        <input
          value={sectorCapsDraft}
          onChange={(event) => setSectorCapsDraft(event.target.value)}
          onBlur={() => updatePolicy({ sectorCaps: parseSectorCaps(sectorCapsDraft) })}
          placeholder="Technology:25, Financials:20"
        />
      </label>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={policy.runDuringExtendedHours}
          onChange={(event) => updatePolicy({ runDuringExtendedHours: event.target.checked })}
        />
        Run during extended hours
      </label>
      <p className="subtle">
        Remaining today: {money(remainingNotional)} notional and {remainingOrders} orders.
      </p>
    </section>
  );
}

function ProfilePanel({
  snapshot,
  newProfileName,
  setNewProfileName,
  activateProfile,
  createProfile
}: {
  snapshot: DashboardSnapshot;
  newProfileName: string;
  setNewProfileName: (value: string) => void;
  activateProfile: (profileId: string) => void;
  createProfile: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Strategy Profile</h2>
        <span className="status-badge status-completed">{snapshot.activeProfile?.name ?? "Default"}</span>
      </div>
      <label>
        Active profile
        <select value={snapshot.activeProfile?.id ?? ""} onChange={(event) => activateProfile(event.target.value)}>
          {snapshot.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>
      <div className="inline-form">
        <input value={newProfileName} onChange={(event) => setNewProfileName(event.target.value)} placeholder="New profile name" />
        <button onClick={createProfile} disabled={!newProfileName.trim()}>
          Create
        </button>
      </div>
      <p className="subtle">Profiles store policy, prompt, scoring weights, and active selection.</p>
    </section>
  );
}

function LatestDecision({
  decision,
  symbolMetaBySymbol
}: {
  decision?: DashboardSnapshot["latestStrategyRun"];
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
}) {
  const [showColumnSettings, setShowColumnSettings] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<Record<string, boolean>>({
    symbol: true,
    price: true,
    bid: false,
    ask: false,
    intradayChangePct: true,
    volume: true,
    marketCap: true,
    peRatio: true,
    dividendYield: true,
    eps: true,
    sentiment: true,
    analystScore: true,
    sector: true,
    score: true
  });

  const columnsList = [
    { id: "symbol", label: "Symbol" },
    { id: "price", label: "Price" },
    { id: "bid", label: "Bid" },
    { id: "ask", label: "Ask" },
    { id: "intradayChangePct", label: "Change" },
    { id: "volume", label: "VOL" },
    { id: "marketCap", label: "Mkt Cap" },
    { id: "peRatio", label: "P/E" },
    { id: "dividendYield", label: "Div Yield" },
    { id: "eps", label: "EPS" },
    { id: "sentiment", label: "Sentiment" },
    { id: "analystScore", label: "Rating" },
    { id: "sector", label: "Sector" },
    { id: "score", label: "Score" }
  ];

  const toggleColumn = (colId: string) => {
    setVisibleColumns(prev => ({ ...prev, [colId]: !prev[colId] }));
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Latest Strategy Decision</h2>
      </div>
      {!decision ? (
        <p className="subtle">Run the strategy once to generate a decision.</p>
      ) : (
        <div className="decision-list">
          <p className={decision.status === "failed" ? "warning" : "result"}>{decision.summary}</p>
          {decision.marketScan ? (
            <div>
              <div className="scan-summary">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", flexWrap: "wrap", gap: "8px" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" }}>
                    <strong>Market Scan</strong>
                    <span style={{ fontSize: "11px" }}>
                      utilized information on {decision.marketScan.scannedSymbols} symbols sourced at {new Date(decision.marketScan.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} from: {formatSources(decision.marketScan.source)}
                      {decision.marketScan.cached ? " · cached" : ""}
                    </span>
                  </div>
                  <button 
                    onClick={() => setShowColumnSettings(!showColumnSettings)}
                    style={{
                      background: "none",
                      border: "none",
                      padding: "4px",
                      minHeight: "auto",
                      color: "var(--muted)",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center"
                    }}
                    title="Configure Columns"
                  >
                    <Settings size={16} />
                  </button>
                </div>
                {showColumnSettings && (
                  <div style={{
                    borderTop: "1px solid var(--line)",
                    paddingTop: "12px",
                    marginTop: "4px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px"
                  }}>
                    <div style={{ fontSize: "12px", fontWeight: "600" }}>Market Scan Columns:</div>
                    <div style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
                      gap: "8px"
                    }}>
                      {columnsList.map(col => (
                        <label 
                          key={col.id} 
                          style={{ 
                            display: "flex", 
                            alignItems: "center", 
                            gap: "6px", 
                            cursor: "pointer",
                            fontSize: "11px",
                            userSelect: "none"
                          }}
                        >
                          <input 
                            type="checkbox" 
                            checked={visibleColumns[col.id] || false} 
                            onChange={() => toggleColumn(col.id)}
                            style={{ cursor: "pointer" }}
                          />
                          {col.label}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <ScanTable candidates={decision.marketScan.topCandidates} visibleColumns={visibleColumns} />
            </div>
          ) : null}
          {decision.proposals.map((item, index) => (
            <div className="decision" key={`${item.proposal.symbol}-${index}`}>
              <strong title={companyTitle(item.proposal.symbol, symbolMetaBySymbol)}>
                {displayStatus(item.status)} <strong className={item.proposal.side === "buy" ? "text-green" : "text-red"}>{item.proposal.side.toUpperCase()}</strong> {item.proposal.symbol}
              </strong>
              <span>
                {proposalSize(item.proposal)} | {item.proposal.type}
              </span>
              <p>{item.proposal.rationale}</p>
              {item.reasons.length ? <code>{item.reasons.join("; ")}</code> : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PendingProposals({
  proposals,
  symbolMetaBySymbol,
  busy,
  approve,
  reject
}: {
  proposals: DashboardSnapshot["pendingProposals"];
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
  busy: boolean;
  approve: (proposalId: string) => void;
  reject: (proposalId: string) => void;
}) {
  if (proposals.length === 0) return null;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Pending Proposals ({proposals.length})</h2>
      </div>
      <div className="proposal-list">
        {proposals.map((pending) => (
          <div key={pending.id} className="proposal-card">
            <div className="proposal-header">
              <strong title={companyTitle(pending.proposal.symbol, symbolMetaBySymbol)}>
                <strong className={pending.proposal.side === "buy" ? "text-green" : "text-red"}>{pending.proposal.side.toUpperCase()}</strong> {pending.proposal.symbol}
              </strong>
              <span className="proposal-meta">{proposalSize(pending.proposal)} · {pending.proposal.type}</span>
              <span className="proposal-meta">{new Date(pending.createdAt).toLocaleString()}</span>
            </div>
            <p className="proposal-rationale">{pending.proposal.rationale}</p>
            <div className="proposal-actions">
              <button className="approve" disabled={busy} onClick={() => approve(pending.id)}>
                <CheckCircle size={15} />
                Approve
              </button>
              <button className="ghost" disabled={busy} onClick={() => reject(pending.id)}>
                <XCircle size={15} />
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RunHistory({ runs }: { runs: DashboardSnapshot["strategyRuns"] }) {
  return (
    <section className="panel run-history">
      <div className="panel-head">
        <h2>Strategy Run History</h2>
      </div>
      {runs.length === 0 ? (
        <p className="subtle">No strategy runs yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Status</th>
              <th>Total</th>
              <th>Placed</th>
              <th>Paper</th>
              <th>Pending</th>
              <th>Blocked</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>{new Date(run.startedAt).toLocaleString()}</td>
                <td><span className={`status-badge status-${run.status}`}>{run.status}</span></td>
                <td>{run.totalCount}</td>
                <td>{run.placedCount}</td>
                <td>{run.paperCount}</td>
                <td>{run.proposedCount}</td>
                <td>{run.blockedCount}</td>
                <td><span className="subtle-text">{run.summary}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PositionsTable({
  positions,
  portfolio,
  symbolMetaBySymbol
}: {
  positions: EquityPosition[];
  portfolio?: DashboardSnapshot["portfolio"];
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
}) {
  const [sort, setSort] = useState<{ col: keyof EnrichedPosition; dir: SortDir }>({ col: "marketValue", dir: "desc" });
  const [widths, setWidths] = useState<Record<string, number>>({});
  const total = portfolio?.totalMarketValue ?? 0;
  const enriched = enrichPositionsForDisplay(positions, total);
  const sorted = [...enriched].sort((left, right) => compare(left[sort.col], right[sort.col], sort.dir));

  const startResize = (col: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = e.currentTarget.parentElement?.getBoundingClientRect().width || 100;

    const doDrag = (moveEvent: MouseEvent) => {
      const newWidth = Math.max(40, startWidth + (moveEvent.clientX - startX));
      setWidths((prev) => ({ ...prev, [col]: newWidth }));
    };

    const stopDrag = () => {
      document.removeEventListener("mousemove", doDrag);
      document.removeEventListener("mouseup", stopDrag);
    };

    document.addEventListener("mousemove", doDrag);
    document.addEventListener("mouseup", stopDrag);
  };

  return (
    <section className="panel portfolio-table">
      <div className="panel-head">
        <h2>Positions</h2>
      </div>
      {sorted.length === 0 ? (
        <p className="subtle">No open positions.</p>
      ) : (
        <table>
          <thead>
            <tr>
              {positionHeader("Symbol", "symbol", sort, setSort, widths.symbol, startResize("symbol"))}
              {positionHeader("Qty", "quantity", sort, setSort, widths.quantity, startResize("quantity"))}
              {positionHeader("Cost Basis", "costBasis", sort, setSort, widths.costBasis, startResize("costBasis"))}
              {positionHeader("Mkt Value", "marketValue", sort, setSort, widths.marketValue, startResize("marketValue"))}
              {positionHeader("P&L", "pnl", sort, setSort, widths.pnl, startResize("pnl"))}
              {positionHeader("Return", "returnPct", sort, setSort, widths.returnPct, startResize("returnPct"))}
              {positionHeader("Alloc", "allocPct", sort, setSort, widths.allocPct, startResize("allocPct"))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((position) => {
              const cls = position.pnl >= 0 ? "pnl-pos" : "pnl-neg";
              return (
                <tr key={position.symbol}>
                  <td><strong title={companyTitle(position.symbol, symbolMetaBySymbol)}>{position.symbol}</strong></td>
                  <td>{formatShareQuantity(position.quantity, position.symbol)}</td>
    
                  <td>{money(position.costBasis)}</td>
                  <td>{money(position.marketValue)}</td>
                  <td className={cls}>{signedMoney(position.pnl)}</td>
                  <td className={cls}>{formatPct(position.returnPct)}</td>
                  <td>{position.allocPct.toFixed(1)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ScanTable({ 
  candidates,
  visibleColumns = {
    symbol: true,
    price: true,
    bid: false,
    ask: false,
    intradayChangePct: true,
    volume: true,
    marketCap: true,
    peRatio: true,
    dividendYield: true,
    eps: true,
    sentiment: true,
    analystScore: true,
    sector: true,
    score: true
  }
}: { 
  candidates: MarketQuote[];
  visibleColumns?: Record<string, boolean>;
}) {
  const [sort, setSort] = useState<{ col: keyof MarketQuote; dir: SortDir }>({ col: "score", dir: "desc" });
  const [widths, setWidths] = useState<Record<string, number>>({});
  if (candidates.length === 0) return <p className="subtle">No scan candidates returned.</p>;
  const sorted = [...candidates].sort((left, right) => compare(left[sort.col], right[sort.col], sort.dir));

  const startResize = (col: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = e.currentTarget.parentElement?.getBoundingClientRect().width || 100;

    const doDrag = (moveEvent: MouseEvent) => {
      const newWidth = Math.max(40, startWidth + (moveEvent.clientX - startX));
      setWidths((prev) => ({ ...prev, [col]: newWidth }));
    };

    const stopDrag = () => {
      document.removeEventListener("mousemove", doDrag);
      document.removeEventListener("mouseup", stopDrag);
    };

    document.addEventListener("mousemove", doDrag);
    document.addEventListener("mouseup", stopDrag);
  };

  return (
    <div className="scan-candidates">
      <table>
        <thead>
          <tr>
            {visibleColumns.symbol && marketHeader("Symbol", "symbol", sort, setSort, "Ticker symbol sourced from Nasdaq Stock Screener API", widths.symbol, startResize("symbol"))}
            {visibleColumns.price && marketHeader("Price", "price", sort, setSort, "Current price sourced from Robinhood or Yahoo Finance quotes", widths.price, startResize("price"))}
            {visibleColumns.bid && marketHeader("Bid", "bid", sort, setSort, "Bid price sourced from Robinhood or Yahoo Finance quotes", widths.bid, startResize("bid"))}
            {visibleColumns.ask && marketHeader("Ask", "ask", sort, setSort, "Ask price sourced from Robinhood or Yahoo Finance quotes", widths.ask, startResize("ask"))}
            {visibleColumns.intradayChangePct && marketHeader("Change", "intradayChangePct", sort, setSort, "Intraday price change % sourced from Nasdaq Stock Screener", widths.intradayChangePct, startResize("intradayChangePct"))}
            {visibleColumns.volume && marketHeader("VOL", "volume", sort, setSort, "Volume sourced from Nasdaq, Finnhub, or Yahoo Finance", widths.volume, startResize("volume"))}
            {visibleColumns.marketCap && marketHeader("Mkt Cap", "marketCap", sort, setSort, "Market capitalization sourced from Nasdaq Stock Screener", widths.marketCap, startResize("marketCap"))}
            {visibleColumns.peRatio && marketHeader("P/E", "peRatio", sort, setSort, "Price-to-earnings ratio sourced from Finnhub, FMP, or Yahoo Finance", widths.peRatio, startResize("peRatio"))}
            {visibleColumns.dividendYield && marketHeader("Div Yield", "dividendYield", sort, setSort, "Annual dividend yield % sourced from Finnhub or Yahoo Finance", widths.dividendYield, startResize("dividendYield"))}
            {visibleColumns.eps && marketHeader("EPS", "eps", sort, setSort, "Earnings per share (TTM) sourced from Finnhub or Yahoo Finance", widths.eps, startResize("eps"))}
            {visibleColumns.sentiment && marketHeader("Sentiment", "sentiment", sort, setSort, "News sentiment score sourced from Finnhub news headlines", widths.sentiment, startResize("sentiment"))}
            {visibleColumns.analystScore && marketHeader("Rating", "analystScore", sort, setSort, "Blended analyst rating consensus sourced from Finnhub, FMP, or Yahoo Finance", widths.analystScore, startResize("analystScore"))}
            {visibleColumns.sector && marketHeader("Sector", "sector", sort, setSort, "Stock sector sourced from Nasdaq, Finnhub, or Yahoo Finance profile", widths.sector, startResize("sector"))}
            {visibleColumns.score && marketHeader("Score", "score", sort, setSort, "Scoring rank calculated dynamically based on active policy weights", widths.score, startResize("score"))}
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, 15).map((candidate) => {
            const src = candidate.sources ?? {};
            // P/E: real value, "n/a" for negative earnings (no meaningful ratio), "-" if unknown.
            const peText = candidate.peRatio && candidate.peRatio > 0
              ? candidate.peRatio.toFixed(1)
              : typeof candidate.eps === "number" && candidate.eps <= 0
                ? "n/a"
                : "-";
            return (
              <tr key={candidate.symbol}>
                {visibleColumns.symbol && <td title={candidate.companyName}><strong>{candidate.symbol}</strong></td>}
                {visibleColumns.price && <td title={quoteTitle("Quote", candidate)}>{money(candidate.price)}</td>}
                {visibleColumns.bid && <td title={quoteTitle("Bid quote", candidate)}>{candidate.bid ? money(candidate.bid) : "-"}</td>}
                {visibleColumns.ask && <td title={quoteTitle("Ask quote", candidate)}>{candidate.ask ? money(candidate.ask) : "-"}</td>}
                {visibleColumns.intradayChangePct && <td title="Intraday price change (Nasdaq Screener)" className={candidate.intradayChangePct >= 0 ? "pnl-pos" : "pnl-neg"}>{formatPct(candidate.intradayChangePct)}</td>}
                {visibleColumns.volume && <td title={cellTitle("Daily trading volume", src.volume ?? candidate.provider)}>{candidate.volume > 0 ? compactNum(candidate.volume) : "-"}</td>}
                {visibleColumns.marketCap && <td title="Market capitalization (Nasdaq Screener)">{candidate.marketCap && candidate.marketCap > 0 ? compactMoney(candidate.marketCap) : "-"}</td>}
                {visibleColumns.peRatio && <td title={cellTitle(peText === "n/a" ? "Price-to-Earnings: negative earnings, no meaningful ratio" : "Price-to-Earnings Ratio", src.peRatio)}>{peText}</td>}
                {visibleColumns.dividendYield && <td title={cellTitle("Annual Dividend Yield %", src.dividendYield)}>{typeof candidate.dividendYield === "number" ? `${candidate.dividendYield.toFixed(2)}%` : "-"}</td>}
                {visibleColumns.eps && <td title={cellTitle("Earnings Per Share (TTM)", src.eps)}>{typeof candidate.eps === "number" ? (candidate.eps >= 0 ? `$${candidate.eps.toFixed(2)}` : `($${Math.abs(candidate.eps).toFixed(2)})`) : "-"}</td>}
                {visibleColumns.sentiment && <td title={sentimentTitle(candidate)}>{typeof candidate.sentiment === "number" ? sentimentLabel(candidate.sentiment) : "-"}</td>}
                {visibleColumns.analystScore && <td title={ratingTitle(candidate)}>{candidate.analystRating ? `${candidate.analystScore ?? ""} ${candidate.analystRating}`.trim() : "-"}</td>}
                {visibleColumns.sector && <td title={cellTitle("Stock Sector", src.sector)}>{candidate.sector ? <span className="sector-tag">{candidate.sector}</span> : "-"}</td>}
                {visibleColumns.score && <td title={factorTitle(candidate)}>{candidate.score.toFixed(1)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function UnifiedActivityFeedPanel({
  unifiedFeed,
  configured,
  symbolMetaBySymbol,
  policy,
  updatePolicy
}: {
  unifiedFeed: UnifiedActivityGroup[];
  configured: boolean;
  symbolMetaBySymbol: Record<string, DashboardSnapshot["symbolMetaBySymbol"][string]>;
  policy: TradingPolicy;
  updatePolicy: (patch: PolicyPatch) => void;
}) {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [modeFilter, setModeFilter] = useState<"all" | "live" | "paper">("all");
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [showSettings, setShowSettings] = useState(false);

  function patchSettings(patch: Partial<NotificationSettings>) {
    updatePolicy({ notificationSettings: { ...policy.notificationSettings, ...patch } });
  }


  const allTags = [
    "policy change",
    "trade",
    "buy",
    "sell",
    "post mortem",
    "notification sent",
    "notification failed",
    "notification disabled"
  ];

  const toggleTag = (tag: string) => {
    setSelectedTags(current =>
      current.includes(tag) ? current.filter(t => t !== tag) : [...current, tag]
    );
  };

  const toggleExpand = (id: string) => {
    setExpandedIds(current => ({ ...current, [id]: !current[id] }));
  };

  const filteredItems = unifiedFeed.filter(item => {
    // 1. Live vs Paper filter
    const isItemPaper = item.tags.includes("paper");
    if (modeFilter === "paper" && !isItemPaper) return false;
    if (modeFilter === "live" && isItemPaper) return false;

    // 2. Tag filtering — show items that have ANY of the selected tags (OR logic)
    if (selectedTags.length > 0) {
      const hasAnySelectedTag = item.tags.some(t => selectedTags.includes(t));
      if (!hasAnySelectedTag) return false;
    }

    return true;
  });

  return (
    <section className="panel unified-activity-panel">
      <div className="panel-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2>Activity Feed</h2>
          <p className="subtle" style={{ margin: 0, fontSize: '12px' }}>Consolidated trading log, audit events, and notifications</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span className={`status-badge ${configured ? "status-completed" : "status-running"}`}>
            {configured ? "Notifications Webhook Configured" : "Notifications Webhook Not Configured"}
          </span>
          <button className="icon-button" onClick={() => setShowSettings(true)} aria-label="Webhook Settings" style={{background:"none", border:"none", cursor:"pointer", color:"var(--text)", padding:"4px", display:"flex", alignItems:"center"}}>
            <Settings size={16} />
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="alert-modal-overlay">
          <div className="alert-modal" style={{ maxWidth: '500px' }}>
            <div className="alert-modal-header">
              <h3>Webhook Settings</h3>
              <button className="close-btn" onClick={() => setShowSettings(false)}>×</button>
            </div>
            <div className="alert-modal-body" style={{ textAlign: 'left' }}>
              <label>
                Notifications Webhook
                <input
                  value={policy.notificationSettings.webhookUrl ?? ""}
                  onChange={(event) => patchSettings({ webhookUrl: event.target.value })}
                  placeholder="https://..."
                  style={{ width: '100%', marginBottom: '16px' }}
                />
              </label>
              <div className="event-toggle-grid">
                {(["fill", "block", "run_failed", "pending_approval", "kill_switch"] as const).map((eventType) => (
                  <label key={eventType} className="inline-check">
                    <input
                      type="checkbox"
                      checked={policy.notificationSettings.enabledEvents.includes(eventType)}
                      onChange={(event) => {
                        const enabledEvents = event.target.checked
                          ? Array.from(new Set([...policy.notificationSettings.enabledEvents, eventType]))
                          : policy.notificationSettings.enabledEvents.filter((item) => item !== eventType);
                        patchSettings({ enabledEvents });
                      }}
                    />
                    {eventType.replace("_", " ")}
                  </label>
                ))}
              </div>
            </div>
            <div className="alert-modal-actions">
              <button onClick={() => setShowSettings(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      <div className="filter-bar" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', padding: '12px 0', borderBottom: '1px solid var(--line)', alignItems: 'center' }}>
        <span style={{ fontSize: '13px', fontWeight: 'bold', color: 'var(--muted)', display: 'flex', alignItems: 'center', marginRight: '4px' }}>Mode:</span>
        {(["all", "live", "paper"] as const).map(mode => {
          const active = modeFilter === mode;
          return (
            <button
              key={mode}
              onClick={() => setModeFilter(mode)}
              style={{
                background: active ? 'var(--text)' : 'transparent',
                color: active ? 'white' : 'var(--text)',
                border: '1px solid var(--line)',
                borderRadius: '8px',
                padding: '4px 10px',
                fontSize: '12px',
                cursor: 'pointer',
                minHeight: '26px',
                display: 'inline-flex',
                alignItems: 'center',
                textTransform: 'capitalize',
                transition: 'all 0.15s ease'
              }}
            >
              {mode}
            </button>
          );
        })}

        <span style={{ fontSize: '13px', fontWeight: 'bold', color: 'var(--muted)', display: 'flex', alignItems: 'center', marginLeft: '12px', marginRight: '4px' }}>Filter:</span>
        {allTags.map(tag => {
          const active = selectedTags.includes(tag);
          return (
            <button
              key={tag}
              onClick={() => toggleTag(tag)}
              className="tag-pill"
              style={{
                background: active ? 'var(--text)' : 'transparent',
                color: active ? 'var(--bg, #fff)' : 'var(--muted)',
                border: active ? '1px solid var(--text)' : '1px solid var(--line)',
                borderRadius: '16px',
                padding: '4px 10px',
                fontSize: '12px',
                cursor: 'pointer',
                minHeight: '26px',
                display: 'inline-flex',
                alignItems: 'center',
                textTransform: 'capitalize',
                transition: 'all 0.15s ease',
                fontWeight: active ? '600' : '400',
                opacity: active ? 1 : 0.7
              }}
            >
              {tag}
            </button>
          );
        })}
        {(selectedTags.length > 0 || modeFilter !== "all") && (
          <button
            onClick={() => {
              setSelectedTags([]);
              setModeFilter("all");
            }}
            style={{
              background: 'transparent',
              color: 'var(--red)',
              border: 'none',
              fontSize: '12px',
              cursor: 'pointer',
              minHeight: '26px',
              padding: '0 4px',
              display: 'inline-flex',
              alignItems: 'center',
              fontWeight: 'bold'
            }}
          >
            Reset Filters
          </button>
        )}
      </div>

      {filteredItems.length === 0 ? (
        <p className="subtle" style={{ padding: '24px 0', textAlign: 'center' }}>No activities match the selected filters.</p>
      ) : (
        <div className="audit" style={{ maxHeight: '600px', overflowY: 'auto' }}>
          {filteredItems.slice(0, 50).map(group => {
            const isExpanded = !!expandedIds[group.id];
            const hasSubEvents = group.events && group.events.length > 1;

            let borderStyle = '3px solid var(--line)';
            if (group.tags.includes('policy change')) {
              borderStyle = '3px solid var(--blue)';
            } else if (group.status === 'filled') {
              borderStyle = '3px solid var(--green)';
            } else if (group.status === 'blocked' || group.status === 'rejected') {
              borderStyle = '3px solid var(--red)';
            } else if (group.status === 'pending_approval' || group.status === 'pending') {
              borderStyle = '3px solid #f0a000';
            }

            return (
              <div
                key={group.id}
                className="activity-group-row"
                style={{
                  borderLeft: borderStyle,
                  paddingLeft: '12px',
                  marginBottom: '8px',
                  background: 'rgba(0,0,0,0.01)',
                  borderRadius: '0 8px 8px 0',
                  borderBottom: '1px solid var(--line)'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', alignItems: 'start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                      <span className="audit-time" style={{ color: 'var(--muted)', fontSize: '11px' }}>
                        {new Date(group.updatedAt).toLocaleString()}
                      </span>
                      {group.companyName && (
                        <span style={{ fontSize: '11px', color: 'var(--muted)' }}>({group.companyName})</span>
                      )}
                    </div>
                    
                    <div style={{ margin: '4px 0' }}>
                      {renderActionTitle(group.title)}
                    </div>
                    
                    <div className="activity-detail" title={group.detail} style={{ fontSize: '13px', color: 'var(--text)' }}>
                      {group.detail}
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                      {group.tags.map(t => (
                        <span
                          key={t}
                          style={{
                            fontSize: '10px',
                            background: '#e8ece9',
                            color: 'var(--muted)',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            textTransform: 'uppercase',
                            fontWeight: 'bold'
                          }}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'end', gap: '8px', marginLeft: '12px' }}>
                    <span
                      style={{
                        fontSize: '11px',
                        fontWeight: 'bold',
                        padding: '3px 8px',
                        borderRadius: '12px',
                        textTransform: 'uppercase',
                        background:
                          group.status === 'filled' ? 'rgba(17,107,75,0.1)' :
                          group.status === 'blocked' || group.status === 'rejected' ? 'rgba(179,38,30,0.1)' :
                          group.status === 'approved' ? 'rgba(17,107,75,0.05)' :
                          group.status === 'pending_approval' ? 'rgba(240,160,0,0.1)' :
                          'rgba(0,0,0,0.05)',
                        color:
                          group.status === 'filled' ? 'var(--green)' :
                          group.status === 'blocked' || group.status === 'rejected' ? 'var(--red)' :
                          group.status === 'approved' ? 'var(--green)' :
                          group.status === 'pending_approval' ? '#c08000' :
                          'var(--text)'
                      }}
                    >
                      {group.status.replace(/_/g, ' ')}
                    </span>

                    {hasSubEvents && (
                      <button
                        onClick={() => toggleExpand(group.id)}
                        className="ghost sm"
                        style={{ padding: '2px 8px', fontSize: '11px', minHeight: '24px' }}
                      >
                        {isExpanded ? "Hide Details" : `Show Details (${group.events.length})`}
                      </button>
                    )}
                  </div>
                </div>

                {isExpanded && hasSubEvents && (
                  <div
                    className="timeline-sub-events"
                    style={{
                      borderTop: '1px dashed var(--line)',
                      margin: '6px 0 10px 0',
                      paddingTop: '8px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px'
                    }}
                  >
                    {group.events.map(ev => {
                      let typeColor = 'var(--muted)';
                      if (ev.type === 'fill') typeColor = 'var(--green)';
                      if (ev.type === 'notification' && ev.status === 'failed') typeColor = 'var(--red)';

                      return (
                        <div
                          key={ev.id}
                          style={{
                            display: 'flex',
                            gap: '12px',
                            fontSize: '12px',
                            lineHeight: '1.4',
                            padding: '4px 0'
                          }}
                        >
                          <div style={{ color: 'var(--muted)', width: '130px', flexShrink: 0 }}>
                            {new Date(ev.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </div>
                          
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: '500' }}>
                              {renderActionTitle(ev.title)}
                            </div>
                            <div className="activity-detail" title={ev.detail} style={{ color: 'var(--muted)', fontSize: '11px' }}>
                              {ev.detail}
                            </div>
                          </div>

                          <div style={{ flexShrink: 0, textTransform: 'capitalize', fontSize: '11px', color: typeColor, fontWeight: 'bold' }}>
                            {ev.type}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function positionHeader(
  label: string,
  col: keyof EnrichedPosition,
  sort: { col: keyof EnrichedPosition; dir: SortDir },
  setSort: (sort: { col: keyof EnrichedPosition; dir: SortDir }) => void,
  width?: number,
  onResizeStart?: (e: React.MouseEvent) => void
) {
  return sortableHeader(label, col, sort, setSort, undefined, width, onResizeStart);
}

function marketHeader(
  label: string,
  col: keyof MarketQuote,
  sort: { col: keyof MarketQuote; dir: SortDir },
  setSort: (sort: { col: keyof MarketQuote; dir: SortDir }) => void,
  title?: string,
  width?: number,
  onResizeStart?: (e: React.MouseEvent) => void
) {
  return sortableHeader(label, col, sort, setSort, title, width, onResizeStart);
}

function sortableHeader<T extends string>(
  label: string,
  col: T,
  sort: { col: T; dir: SortDir },
  setSort: (sort: { col: T; dir: SortDir }) => void,
  title?: string,
  width?: number,
  onResizeStart?: (e: React.MouseEvent) => void
) {
  const active = sort.col === col;
  return (
    <th
      key={col}
      className="sortable-th"
      onClick={() => setSort({ col, dir: active && sort.dir === "desc" ? "asc" : "desc" })}
      title={title}
      style={width ? { width: `${width}px` } : undefined}
    >
      {label} <span className="sort-arrow">{active ? (sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
      {onResizeStart && (
        <div
          className="resize-handle"
          onMouseDown={onResizeStart}
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </th>
  );
}

function compare(left: unknown, right: unknown, dir: SortDir): number {
  const order = dir === "asc" ? 1 : -1;
  if (typeof left === "string" || typeof right === "string") return String(left ?? "").localeCompare(String(right ?? "")) * order;
  return (Number(left ?? 0) - Number(right ?? 0)) * order;
}

function proposalSize(proposal: TradeProposal): string {
  if (proposal.dollarAmount) return money(proposal.dollarAmount);
  if (proposal.quantity) return `${formatShareQuantity(proposal.quantity, proposal.symbol)} shares`;
  return "No size";
}

function displayStatus(status: string): string {
  if (status === "paper") return "PAPER";
  return status.toUpperCase();
}

function nextRunLabel(policy: TradingPolicy, nextRunAt?: string | null): string {
  if (!policy.enabled || policy.killSwitch) return "-";
  return nextRunAt ? new Date(nextRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "awaiting tick";
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

function factorTitle(candidate: MarketQuote): string {
  const factors = candidate.factorBreakdown;
  if (!factors) return "No factor breakdown";
  const entries = Object.entries(factors)
    .filter(([key]) => key !== "weightedTotal")
    .map(([key, value]) => `${key}: ${Number(value).toFixed(1)}`);
  return entries.join(" | ");
}

function formatSources(sourceString: string): string {
  if (!sourceString) return "";
  const parts = sourceString.split("+");
  const mapped = parts.map(part => {
    switch (part.trim().toLowerCase()) {
      case "nasdaq-delayed-screener":
        return "NASDAQ Delayed Screener";
      case "finnhub":
        return "Finnhub";
      case "yahoo-finance":
        return "Yahoo Finance";
      case "fmp":
        return "FMP";
      case "alpha-vantage":
        return "Alpha Vantage";
      default:
        return part.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    }
  });
  return mapped.join(", ");
}

function sentimentLabel(value: number) {
  const tone = value >= 60 ? "positive" : value <= 40 ? "negative" : "neutral";
  const label = value >= 60 ? "Positive" : value <= 40 ? "Negative" : "Neutral";
  return <span className={`sentiment-chip sentiment-${tone}`}>{label} {value}</span>;
}

function TradeRow({
  fill,
  symbolMetaBySymbol
}: {
  fill: FillEvent;
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
}) {
  return (
    <div className="audit-row">
      <span className="audit-time">{new Date(fill.filledAt).toLocaleString()}</span>
      <strong title={companyTitle(fill.symbol, symbolMetaBySymbol)}>
        {fill.source === "paper" ? "Paper " : ""}
        <span className={fill.side === "buy" ? "text-green" : "text-red"}>{fill.side === "buy" ? "BUY" : "SELL"}</span> {fill.symbol}
      </strong>
      <span>
        {formatShareQuantity(fill.quantity, fill.symbol)} shares @ {money(fill.price)} · {fill.status}
      </span>
    </div>
  );
}

function renderActionTitle(title: string, hoverTitle?: string) {
  const match = title.match(/^(Paper\s+)?(buy|sell|bought|sold|buy:|sell:)\b(.*)$/i);
  if (!match) return <strong title={hoverTitle}>{title}</strong>;
  const [, paperPrefix = "", action, rest] = match;
  const actionClass = /sell|sold/i.test(action) ? "text-red" : "text-green";
  return (
    <strong title={hoverTitle}>
      {paperPrefix}
      <span className={actionClass}>{action.toUpperCase()}</span>
      {rest}
    </strong>
  );
}
