"use client";

import { AlertTriangle, CheckCircle, Pause, Play, RefreshCw, RotateCcw, Shield, XCircle, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_STRATEGY_PROMPT } from "@/lib/defaults";
import { SP500_SYMBOLS } from "@/lib/sp500";
import type { EquityOrder, EquityPosition, MarketQuote, NotificationSettings, ScoringWeights, TradingPolicy, TradeProposal } from "@/lib/types";
import type { AuditEvent, DashboardSnapshot } from "./dashboard-types";
import {
  AllocationDonut,
  Metric,
  NotificationPanel,
  NumberField,
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

export function DashboardClient({ initialSnapshot }: { initialSnapshot: DashboardSnapshot }) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(initialSnapshot);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [alertMessage, setAlertMessage] = useState<{ title: string; body: string; type: "error" | "warning" | "success" } | null>(null);
  const [newProfileName, setNewProfileName] = useState("");
  const [sectorCapsDraft, setSectorCapsDraft] = useState(formatSectorCaps(initialSnapshot.policy.sectorCaps));
  const promptSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Local-only trading control</p>
          <h1>Robinhood Agentic Dashboard</h1>
        </div>
        <div className="actions">
          <button aria-label="Refresh dashboard" onClick={() => load()} disabled={busy}>
            <RefreshCw size={18} />
            Refresh
          </button>
          <button className="danger" onClick={() => updatePolicy({ killSwitch: true, enabled: false })}>
            <Pause size={18} />
            Kill Switch
          </button>
        </div>
      </header>

      <section className="status-grid-8">
        <Metric label={`${policy.paperMode ? "Paper" : "Live"} Portfolio`} value={money(snapshot.portfolio?.totalMarketValue)} />
        <Metric label="Buying Power" value={money(snapshot.portfolio?.buyingPower)} />
        <Metric label="Autonomy" value={policy.enabled ? "Enabled" : "Paused"} />
        <Metric label="Mode" value={policy.paperMode ? "Paper" : "Live"} />
        <Metric label="Orders Today" value={`${dailyStats.orderCount} / ${policy.maxDailyOrders}`} />
        <Metric label="Daily Notional" value={`${money(dailyStats.notional)} used`} />
        <Metric label="Market" value={snapshot.marketSession ?? "-"} />
        <Metric label="Next Run" value={nextRunLabel(policy, snapshot.scheduler?.nextRunAt)} />
      </section>

      {error && (
        <p className="warning">
          <AlertTriangle size={16} /> {error}
        </p>
      )}
      {result && <p className="result">{result}</p>}

      <section className="columns">
        <PerformancePanel performance={snapshot.performance} mode={mode} />
        <section className="panel">
          <div className="panel-head">
            <h2>Allocation</h2>
          </div>
          <AllocationDonut positions={snapshot.positions} portfolio={snapshot.portfolio} />
        </section>
      </section>

      <section className="band">
        <section className="panel">
          <div className="panel-head">
            <h2>Controls</h2>
            <Shield size={20} />
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
              {policy.enabled ? "Pause Autonomy" : "Enable Autonomy"}
            </button>
            <button onClick={() => updatePolicy({ paperMode: !policy.paperMode })}>
              {policy.paperMode ? "Switch to Live" : "Switch to Paper"}
            </button>
            <button onClick={runStrategy} disabled={busy}>
              <Zap size={18} />
              Run Once
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

        <RiskPanel
          policy={policy}
          remainingNotional={remainingNotional}
          remainingOrders={remainingOrders}
          sectorCapsDraft={sectorCapsDraft}
          setSectorCapsDraft={setSectorCapsDraft}
          updatePolicy={updatePolicy}
        />
      </section>

      <section className="band">
        <ProfilePanel
          snapshot={snapshot}
          newProfileName={newProfileName}
          setNewProfileName={setNewProfileName}
          activateProfile={activateProfile}
          createProfile={createProfile}
        />
        <NotificationSettingsPanel policy={policy} updatePolicy={updatePolicy} />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Scoring Weights</h2>
          <span className="subtle-text">Used before the LLM sees scan candidates.</span>
        </div>
        <ScoringWeightsEditor weights={policy.scoringWeights} onCommit={(scoringWeights) => updatePolicy({ scoringWeights })} />
      </section>

      <section className="panel">
        <div className="panel-head">
          <div className="prompt-head">
            <h2>Strategy Prompt</h2>
            <button
              className="ghost sm"
              onClick={() => {
                setSnapshot((current) => ({ ...current, strategyPrompt: DEFAULT_STRATEGY_PROMPT }));
                void saveStrategyPrompt(DEFAULT_STRATEGY_PROMPT);
              }}
            >
              <RotateCcw size={14} />
              Reset
            </button>
          </div>
        </div>
        <textarea
          value={snapshot.strategyPrompt}
          onChange={(event) => {
            const value = event.target.value;
            setSnapshot((current) => ({ ...current, strategyPrompt: value }));
            if (promptSaveTimer.current) clearTimeout(promptSaveTimer.current);
            promptSaveTimer.current = setTimeout(() => saveStrategyPrompt(value), 800);
          }}
        />
      </section>

      <LatestDecision decision={snapshot.latestStrategyRun} />
      <PendingProposals proposals={snapshot.pendingProposals} busy={busy} approve={approveProposal} reject={rejectProposal} />
      <RunHistory runs={snapshot.strategyRuns} />

      <section className="columns">
        <PositionsTable positions={snapshot.positions} portfolio={snapshot.portfolio} />
        <OrdersTable orders={snapshot.orders} />
      </section>

      <section className="columns">
        <NotificationPanel notifications={snapshot.notifications} configured={snapshot.notificationStatus.configured} />
        <AuditPanel audit={snapshot.audit} />
      </section>

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
    </main>
  );
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
        <NumberField label="Max daily ($)" value={policy.maxDailyNotional} onCommit={(value) => updatePolicy({ maxDailyNotional: value })} />
        <NumberField label="Max symbol (%)" value={policy.maxSymbolExposurePct} onCommit={(value) => updatePolicy({ maxSymbolExposurePct: value })} />
        <NumberField label="Max orders/day" value={policy.maxDailyOrders} onCommit={(value) => updatePolicy({ maxDailyOrders: value })} />
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

function NotificationSettingsPanel({ policy, updatePolicy }: { policy: TradingPolicy; updatePolicy: (patch: PolicyPatch) => void }) {
  function patchSettings(patch: Partial<NotificationSettings>) {
    updatePolicy({ notificationSettings: { ...policy.notificationSettings, ...patch } });
  }
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Webhook Settings</h2>
      </div>
      <label>
        Webhook URL
        <input
          value={policy.notificationSettings.webhookUrl ?? ""}
          onChange={(event) => patchSettings({ webhookUrl: event.target.value })}
          placeholder="https://..."
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
    </section>
  );
}

function LatestDecision({ decision }: { decision?: DashboardSnapshot["latestStrategyRun"] }) {
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
                <div>
                  <strong>Market Scan</strong>
                  <span>
                    {decision.marketScan.returnedQuotes} / {decision.marketScan.scannedSymbols} symbols from {decision.marketScan.source}
                    {decision.marketScan.cached ? " · cached" : ""}
                  </span>
                </div>
              </div>
              <ScanTable candidates={decision.marketScan.topCandidates} />
            </div>
          ) : null}
          {decision.proposals.map((item, index) => (
            <div className="decision" key={`${item.proposal.symbol}-${index}`}>
              <strong>
                {displayStatus(item.status)} {item.proposal.side.toUpperCase()} {item.proposal.symbol}
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
  busy,
  approve,
  reject
}: {
  proposals: DashboardSnapshot["pendingProposals"];
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
              <strong className={pending.proposal.side === "buy" ? "text-green" : "text-red"}>
                {pending.proposal.side.toUpperCase()} {pending.proposal.symbol}
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

function PositionsTable({ positions, portfolio }: { positions: EquityPosition[]; portfolio?: DashboardSnapshot["portfolio"] }) {
  const [sort, setSort] = useState<{ col: keyof EnrichedPosition; dir: SortDir }>({ col: "marketValue", dir: "desc" });
  const total = portfolio?.totalMarketValue ?? 0;
  const enriched: EnrichedPosition[] = positions.map((position) => {
    const costBasis = position.averageCost * position.quantity;
    const pnl = position.marketValue - costBasis;
    return {
      ...position,
      pnl,
      returnPct: costBasis > 0 ? (pnl / costBasis) * 100 : 0,
      allocPct: total > 0 ? (position.marketValue / total) * 100 : 0
    };
  });
  const sorted = [...enriched].sort((left, right) => compare(left[sort.col], right[sort.col], sort.dir));
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Positions</h2>
      </div>
      {sorted.length === 0 ? (
        <p className="subtle">No open positions.</p>
      ) : (
        <table>
          <thead>
            <tr>
              {positionHeader("Symbol", "symbol", sort, setSort)}
              {positionHeader("Qty", "quantity", sort, setSort)}
              {positionHeader("Avg Cost", "averageCost", sort, setSort)}
              {positionHeader("Mkt Value", "marketValue", sort, setSort)}
              {positionHeader("P&L", "pnl", sort, setSort)}
              {positionHeader("Return", "returnPct", sort, setSort)}
              {positionHeader("Alloc", "allocPct", sort, setSort)}
            </tr>
          </thead>
          <tbody>
            {sorted.map((position) => {
              const cls = position.pnl >= 0 ? "pnl-pos" : "pnl-neg";
              return (
                <tr key={position.symbol}>
                  <td><strong>{position.symbol}</strong></td>
                  <td>{compactNum(position.quantity)}</td>
                  <td>{money(position.marketValue / position.quantity)}</td>
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

interface EnrichedPosition extends EquityPosition {
  pnl: number;
  returnPct: number;
  allocPct: number;
}

function OrdersTable({ orders }: { orders: EquityOrder[] }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Recent Orders</h2>
      </div>
      {orders.length === 0 ? (
        <p className="subtle">No recent orders.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Side</th>
              <th>Type</th>
              <th>State</th>
              <th>Filled</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <td><strong>{order.symbol}</strong></td>
                <td>{order.side}</td>
                <td>{order.type}</td>
                <td>{order.state}</td>
                <td>{order.filledQuantity ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ScanTable({ candidates }: { candidates: MarketQuote[] }) {
  const [sort, setSort] = useState<{ col: keyof MarketQuote; dir: SortDir }>({ col: "score", dir: "desc" });
  if (candidates.length === 0) return <p className="subtle">No scan candidates returned.</p>;
  const sorted = [...candidates].sort((left, right) => compare(left[sort.col], right[sort.col], sort.dir));
  return (
    <div className="scan-candidates">
      <table>
        <thead>
          <tr>
            {marketHeader("Symbol", "symbol", sort, setSort, "Sourced from Nasdaq Stock Screener API")}
            {marketHeader("Price", "price", sort, setSort, "Sourced from Robinhood/Mock quotes or Yahoo Finance fallback")}
            {marketHeader("Bid", "bid", sort, setSort, "Sourced from Robinhood/Mock quotes or Yahoo Finance fallback")}
            {marketHeader("Ask", "ask", sort, setSort, "Sourced from Robinhood/Mock quotes or Yahoo Finance fallback")}
            {marketHeader("Change", "intradayChangePct", sort, setSort, "Sourced from Nasdaq Stock Screener (intraday delay)")}
            {marketHeader("Volume", "volume", sort, setSort, "Sourced from Nasdaq, Finnhub, or Yahoo Finance")}
            {marketHeader("Mkt Cap", "marketCap", sort, setSort, "Market capitalization from Nasdaq Screener")}
            {marketHeader("P/E", "peRatio", sort, setSort, "Sourced from Finnhub API or Fallback Company Fundamentals")}
            {marketHeader("Div Yield", "dividendYield", sort, setSort, "Annual dividend yield % from Finnhub basic financials")}
            {marketHeader("EPS", "eps", sort, setSort, "Earnings per share (TTM) from Finnhub basic financials")}
            {marketHeader("Sentiment", "sentiment", sort, setSort, "Calculated from recent company headlines / news tone analysis")}
            {marketHeader("Rating", "analystRating", sort, setSort, "Sourced from Finnhub analyst recommendation consensus or mock metrics")}
            {marketHeader("Sector", "sector", sort, setSort, "Sourced from Nasdaq Screener or company profile metadata")}
            {marketHeader("Score", "score", sort, setSort, "Calculated dynamically based on active scoring weights")}
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, 15).map((candidate) => {
            const sourceName = candidate.provider === "yahoo-finance" ? "Yahoo Finance" : candidate.provider ?? "unknown";
            const quoteSource = `Source: ${sourceName}`;
            const sentimentTitle = typeof candidate.sentiment === "number"
              ? `Sentiment Score: ${candidate.sentiment}/100 (from Finnhub News or Fallback)\n\nRecent Headlines:\n${candidate.headlines?.map(h => `• ${h}`).join("\n") ?? "None"}`
              : "No sentiment data";
            return (
              <tr key={candidate.symbol}>
                <td title="Stock Symbol (from Nasdaq Screener)"><strong>{candidate.symbol}</strong></td>
                <td title={quoteSource}>{money(candidate.price)}</td>
                <td title={quoteSource}>{candidate.bid ? money(candidate.bid) : "-"}</td>
                <td title={quoteSource}>{candidate.ask ? money(candidate.ask) : "-"}</td>
                <td title="Intraday price change (from Nasdaq Screener)" className={candidate.intradayChangePct >= 0 ? "pnl-pos" : "pnl-neg"}>{formatPct(candidate.intradayChangePct)}</td>
                <td title="Daily trading volume (from Nasdaq, Finnhub, or Yahoo Finance)">{candidate.volume > 0 ? compactNum(candidate.volume) : "-"}</td>
                <td title="Market capitalization (from Nasdaq Screener)">{candidate.marketCap && candidate.marketCap > 0 ? compactMoney(candidate.marketCap) : "-"}</td>
                <td title="Price-to-Earnings Ratio (from Finnhub or Fallback)">{candidate.peRatio ? candidate.peRatio.toFixed(1) : "-"}</td>
                <td title="Annual Dividend Yield % (from Finnhub basic financials)">{typeof candidate.dividendYield === "number" ? `${candidate.dividendYield.toFixed(2)}%` : "-"}</td>
                <td title="Earnings Per Share TTM (from Finnhub basic financials)">{typeof candidate.eps === "number" ? `$${candidate.eps.toFixed(2)}` : "-"}</td>
                <td title={sentimentTitle}>{typeof candidate.sentiment === "number" ? sentimentLabel(candidate.sentiment) : "-"}</td>
                <td title="Analyst consensus rating (from Finnhub or Fallback)">{candidate.analystRating ?? "-"}</td>
                <td title="Stock Sector (from Nasdaq Screener or profile metadata)">{candidate.sector ? <span className="sector-tag">{candidate.sector}</span> : "-"}</td>
                <td title={factorTitle(candidate)}>{candidate.score.toFixed(1)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AuditPanel({ audit }: { audit: AuditEvent[] }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Audit Feed</h2>
      </div>
      {audit.length === 0 ? (
        <p className="subtle">No audit events yet.</p>
      ) : (
        <div className="audit">
          {audit.slice(0, 20).map((event) => (
            <AuditRow key={event.id} event={event} />
          ))}
        </div>
      )}
    </section>
  );
}

function AuditRow({ event }: { event: AuditEvent }) {
  const payload = asRecord(event.payload);
  const label =
    event.kind === "strategy_run"
      ? payload.status === "failed" ? "Strategy Failed" : "Strategy Run"
      : event.kind === "policy_change"
        ? "Policy Updated"
        : event.kind === "notification"
          ? "Notification"
          : event.kind;
  const detail =
    event.kind === "strategy_run"
      ? String(payload.summary ?? "")
      : event.kind === "policy_change"
        ? `Changed: ${String(payload.key ?? "settings")}`
        : event.kind === "notification"
          ? `${String(payload.type ?? "")} ${String(payload.status ?? "")}`
          : JSON.stringify(event.payload).slice(0, 120);
  return (
    <div className="audit-row">
      <span>{new Date(event.createdAt).toLocaleString()}</span>
      <strong>{label}</strong>
      <span>{detail}</span>
    </div>
  );
}

function positionHeader(
  label: string,
  col: keyof EnrichedPosition,
  sort: { col: keyof EnrichedPosition; dir: SortDir },
  setSort: (sort: { col: keyof EnrichedPosition; dir: SortDir }) => void
) {
  return sortableHeader(label, col, sort, setSort);
}

function marketHeader(
  label: string,
  col: keyof MarketQuote,
  sort: { col: keyof MarketQuote; dir: SortDir },
  setSort: (sort: { col: keyof MarketQuote; dir: SortDir }) => void,
  title?: string
) {
  return sortableHeader(label, col, sort, setSort, title);
}

function sortableHeader<T extends string>(
  label: string,
  col: T,
  sort: { col: T; dir: SortDir },
  setSort: (sort: { col: T; dir: SortDir }) => void,
  title?: string
) {
  const active = sort.col === col;
  return (
    <th
      key={col}
      className="sortable-th"
      onClick={() => setSort({ col, dir: active && sort.dir === "desc" ? "asc" : "desc" })}
      title={title}
    >
      {label}{active ? (sort.dir === "asc" ? " ▲" : " ▼") : " ⇅"}
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
  if (proposal.quantity) return `${proposal.quantity} shares`;
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

function sentimentLabel(value: number): string {
  if (value >= 60) return `▲ ${value}`;
  if (value <= 40) return `▼ ${value}`;
  return `– ${value}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
