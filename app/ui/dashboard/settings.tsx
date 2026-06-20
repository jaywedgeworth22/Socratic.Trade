import { INDEX_UNIVERSES, SUPPORTED_INDEX_UNIVERSES } from "@/lib/index-universes";
import type {
    IndexUniverse,
    NotificationSettings,
    ScoringWeights,
    StrategyTuningProposal,
    TradingPolicy
} from "@/lib/types";
import {
    AlertTriangle,
    CheckCircle,
    ChevronRight,
    ExternalLink,
    KeyRound,
    Pause,
    Play,
    Plus,
    RefreshCw,
    RotateCcw,
    Save,
    Trash2,
    Wallet,
    X,
    Zap
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { ApiKeyStatus, DashboardSnapshot, PolicyPatch, RobinhoodMcpHealth } from "../../dashboard-types";
import { money } from "../../dashboard-widgets";
import { cn } from "../../ui/cn";
import {
    Button,
    Chip,
    EmptyState,
    Field,
    Switch,
    Tabs,
    inputClass
} from "../../ui/primitives";
import { NumberField, RangeField } from "./components";
import { formatSectorCaps, labelize, normalizeSymbols, parseSectorCaps, summarizeTuningPatch } from "./utils";

export function SettingsContent({
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
  const [blockDraft, setBlockDraft] = useState("");
  const taxSettings = snapshot.tax?.settings ?? policy.taxSettings ?? { washSaleGuard: true, shortTermRatePct: 24, longTermRatePct: 15 };
  const tuning = policy.tuning ?? {};

  function addAllowlist() {
    if (!draft.trim()) return;
    const next = normalizeSymbols([...policy.additionalSymbols, ...draft.split(/[,\s]+/)]);
    setDraft("");
    updatePolicy({ additionalSymbols: next });
  }

  function addBlocklist() {
    if (!blockDraft.trim()) return;
    const next = normalizeSymbols([...(policy.blocklist || []), ...blockDraft.split(/[,\s]+/)]);
    setBlockDraft("");
    updatePolicy({ blocklist: next });
  }

  function toggleIndex(index: IndexUniverse, checked: boolean) {
    const selected = new Set(policy.includedIndices);
    if (checked) selected.add(index);
    else selected.delete(index);
    updatePolicy({ includedIndices: SUPPORTED_INDEX_UNIVERSES.filter((item) => selected.has(item)) });
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
          <Field label="Base indexes" hint={`${allowedCount} symbol${allowedCount === 1 ? "" : "s"} allowed after ignores`} className="sm:col-span-2">
            <div className="grid gap-2 sm:grid-cols-3">
              {SUPPORTED_INDEX_UNIVERSES.map((index) => {
                const selected = policy.includedIndices.includes(index);
                return (
                  <button
                    key={index}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleIndex(index, !selected)}
                    className={cn(
                      "flex min-h-16 items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-info",
                      selected
                        ? "border-info/60 bg-info/15 text-fg shadow-[inset_0_0_0_1px_rgba(96,165,250,0.22)]"
                        : "border-line bg-bg/60 text-muted hover:border-accent/50 hover:bg-surface-2/70 hover:text-fg"
                    )}
                  >
                    <span>
                      <span className="block font-semibold">{INDEX_UNIVERSES[index].label}</span>
                      <span className={cn("block text-xs", selected ? "text-muted" : "text-faint")}>{INDEX_UNIVERSES[index].symbols.length} symbols</span>
                    </span>
                    <span className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition",
                      selected ? "border-info bg-info text-bg" : "border-line bg-surface-3/50 text-faint"
                    )}>
                      {selected ? <CheckCircle size={15} /> : <Plus size={15} />}
                    </span>
                  </button>
                );
              })}
            </div>
          </Field>
          <div className="grid gap-3 sm:col-span-2 lg:grid-cols-2">
            <Field label="Additional Watchlist" hint="Adds individual tickers on top of the selected base indexes">
              <div className="rounded-lg border border-line bg-bg/60 p-2 focus-within:border-accent">
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {policy.additionalSymbols.map((s) => (
                    <button type="button" key={s} onClick={() => updatePolicy({ additionalSymbols: policy.additionalSymbols.filter((x) => x !== s) })} className="inline-flex items-center gap-1 rounded-md bg-surface-3/50 backdrop-blur-md px-2 py-0.5 text-xs text-fg">
                      {s} <X size={11} />
                    </button>
                  ))}
                </div>
                <input
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
            <Field label="Ignore List" hint="Subtracts symbols from the selected indexes and watchlist">
              <div className="rounded-lg border border-line bg-bg/60 p-2 focus-within:border-accent">
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {(policy.blocklist || []).map((s) => (
                    <button type="button" key={s} onClick={() => updatePolicy({ blocklist: (policy.blocklist || []).filter((x) => x !== s) })} className="inline-flex items-center gap-1 rounded-md bg-down/20 px-2 py-0.5 text-xs font-medium text-down">
                      {s} <X size={11} />
                    </button>
                  ))}
                </div>
                <input
                  value={blockDraft}
                  onChange={(e) => setBlockDraft(e.target.value.toUpperCase())}
                  onBlur={addBlocklist}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addBlocklist();
                    }
                  }}
                  placeholder="Add ticker to ignore"
                  className="w-full bg-transparent text-sm text-fg outline-none placeholder:text-faint disabled:opacity-50"
                />
              </div>
            </Field>
          </div>
          <Field label="Strategy authority" className="sm:col-span-2">
            <select className={inputClass} value={policy.strategyAuthority} onChange={(e) => updatePolicy({ strategyAuthority: e.target.value as TradingPolicy["strategyAuthority"] })}>
              <option value="propose">LLM proposes — you approve</option>
              <option value="decide">LLM decides — runs autonomously</option>
            </select>
          </Field>
          <Field label="Holding horizon" hint="Prompt guidance for the LLM: shapes setup, exit, and tax framing; hard risk limits still come from Risk settings" className="sm:col-span-2">
            <select className={inputClass} value={policy.holdingHorizon ?? "swing"} onChange={(e) => updatePolicy({ holdingHorizon: e.target.value as TradingPolicy["holdingHorizon"] })}>
              <option value="intraday">Intraday — day trades</option>
              <option value="swing">Days to weeks — swing trades</option>
              <option value="position">Weeks to months — position trades</option>
              <option value="longterm">Months to years — long-term (favors long-term tax treatment)</option>
            </select>
          </Field>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button
              variant={policy.systemState === "active" ? "ghost" : "primary"}
              disabled={policy.systemState !== "active" && Boolean(enableBlockedReason)}
              title={policy.systemState !== "active" ? enableBlockedReason : undefined}
              onClick={() => updatePolicy({ systemState: policy.systemState === "active" ? "halted" : "active" })}
            >
              {policy.systemState === "active" ? <Pause size={15} /> : <Play size={15} />} {policy.systemState === "active" ? "Pause autonomy" : "Enable autonomy"}
            </Button>
            <Button variant="ghost" onClick={() => updatePolicy({ paperMode: !policy.paperMode })}>
              {policy.paperMode ? "Switch to Live" : "Switch to Mock/Local"}
            </Button>
          </div>
          {policy.systemState !== "active" && enableBlockedReason && (
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
          <div className="space-y-1 sm:col-span-2">
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={policy.runDuringExtendedHours} onChange={(e) => updatePolicy({ runDuringExtendedHours: e.target.checked })} />
              Run during extended hours
            </label>
            <p className="text-xs leading-relaxed text-faint">
              Allows scheduled or event-triggered strategy runs during 4:00-9:30 AM ET and 4:00-8:00 PM ET. Extended-hours orders still require the separate order permission, and dollar/fractional orders stay regular-hours only.
            </p>
          </div>
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

export function ApiKeysSection() {
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

export function IntegrationsSection({ accounts, onSaved }: { accounts: DashboardSnapshot["connectedAccounts"], onSaved: () => Promise<void> }) {
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
        <h4 className="text-sm font-semibold text-fg">{editing.id ? "Edit Account" : "Add Account"}</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Broker">
            <select className={inputClass} value={editing.broker || "alpaca"} onChange={e => setEditing({ ...editing, broker: e.target.value as any })}>
              <option value="alpaca">Alpaca</option>
              <option value="robinhood">Robinhood</option>
            </select>
          </Field>
          <Field label="Environment">
            <select className={inputClass} value={editing.environment || "paper"} onChange={e => setEditing({ ...editing, environment: e.target.value as any })}>
              <option value="paper">{editing.broker === "alpaca" ? "Alpaca Paper" : "Broker Paper"}</option>
              <option value="live">Live (Real Money)</option>
            </select>
          </Field>
          <Field label="Label (Optional)">
            <input className={inputClass} value={editing.label || ""} onChange={e => setEditing({ ...editing, label: e.target.value })} placeholder="e.g. My Alpaca IRA" />
          </Field>
          <Field label="Account Number (Optional)">
            <input className={inputClass} value={editing.accountNumber || ""} onChange={e => setEditing({ ...editing, accountNumber: e.target.value })} placeholder="e.g. PA12345" />
          </Field>
          <Field label="API Key">
            <input className={inputClass} value={editing.apiKey || ""} onChange={e => setEditing({ ...editing, apiKey: e.target.value })} placeholder="Required for some brokers" />
          </Field>
          <Field label="API Secret">
            <input type="password" className={inputClass} value={editing.apiSecret || ""} onChange={e => setEditing({ ...editing, apiSecret: e.target.value })} placeholder="Required for some brokers" />
          </Field>
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
        <Button variant="ghost" size="sm" onClick={() => setEditing({ broker: "alpaca", environment: "paper" })}>
          <Plus size={14} className="mr-1" /> Add Account
        </Button>
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

export function RobinhoodMcpStatusCard({
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

export function TuningCard({ proposal, onApply }: { proposal: StrategyTuningProposal; onApply: () => void }) {
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

export function ScoringWeights({ weights, onCommit }: { weights: ScoringWeights; onCommit: (w: ScoringWeights) => void }) {
  const keys = Object.keys(weights) as Array<keyof ScoringWeights>;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {keys.map((k) => (
        <NumberField key={k} label={labelize(k)} value={weights[k]} onCommit={(v) => onCommit({ ...weights, [k]: v })} />
      ))}
    </div>
  );
}

export function StrategyStudio({
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
            <RangeField label="Max order $" value={policy.maxOrderNotional ?? 0} min={1} max={1000} step={1} onCommit={(v) => updatePolicy({ maxOrderNotional: v })} />
            <RangeField label="Daily $" value={policy.maxDailyNotional ?? 0} min={10} max={10000} step={10} onCommit={(v) => updatePolicy({ maxDailyNotional: v })} />
            <RangeField label="Symbol cap %" value={policy.maxSymbolExposurePct ?? 0} min={1} max={100} step={1} onCommit={(v) => updatePolicy({ maxSymbolExposurePct: v })} />
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
