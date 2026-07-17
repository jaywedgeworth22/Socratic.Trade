"use client";

import { useEffect, useState, useCallback } from "react";
import { Btn, Card, Select, Segmented, Stat, Toggle } from "../../console/ui/primitives";
import { llmUsageContextLabel } from "../../ui/llm-usage-labels";
import { describeProbeNetworkError, describeProbeStatus, type ProbeErrorDescription } from "../lib/probe-error";

// ── Types ─────────────────────────────────────────────────────────────────────

interface UsageRow {
  userId: string;
  provider: string;
  model: string | null;
  context: string | null;
  keySource: string;
  keyRef: string | null;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  connectedAccountId: string | null;
  broker: string | null;
  environment: string | null;
  accountLabel: string | null;
  keyLabel: string | null;
  keyLast4: string | null;
  keyMasked: string | null;
}

interface UsageData {
  sinceDays: number;
  operatorFallbackEnabled: boolean;
  totalCostUsd: number;
  operatorFundedCostUsd: number;
  operatorFundedTenants: string[];
  rows: UsageRow[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}

// Headline totals show 2 decimals — a $34.8565 total reads as noise. Per-line-item
// costs keep fmtCost's 4dp (sub-cent precision matters for one call, not for a total).
function fmtTotalCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function providerLabel(provider: string): string {
  const map: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic (Claude)",
    xai: "xAI (Grok)",
    gemini: "Google (Gemini)",
    mistral: "Mistral",
    deepseek: "DeepSeek"
  };
  return map[provider] ?? provider;
}

function userLabel(userId: string): string {
  return userId === "local" ? "Primary User" : userId;
}

function keySourceLabel(source: string): string {
  const map: Record<string, string> = {
    user: "User Key",
    operator: "Server Failover"
  };
  return map[source] ?? source;
}

// Human label for the account a usage row is attributed to. Account-less rows (e.g. chat, or
// pre-attribution history) read "Unattributed" rather than being hidden or mislabeled.
function accountLabelText(row: UsageRow): string {
  if (!row.connectedAccountId) return "Unattributed";
  const name = row.accountLabel ?? `acct ${row.connectedAccountId.slice(0, 8)}`;
  const broker = row.broker ? (row.environment ? `${row.broker} · ${row.environment}` : row.broker) : null;
  return broker ? `${name} (${broker})` : name;
}

// Group rows by (userId, provider, keyRef, account) → list of (model, context, ...) sub-rows, so
// spend is broken out per connected account/broker as well as per key.
function groupRows(rows: UsageRow[]): Map<string, UsageRow[]> {
  const groups = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const key = `${row.userId}||${row.provider}||${row.keyRef ?? "none"}||${row.connectedAccountId ?? "none"}`;
    const existing = groups.get(key) ?? [];
    existing.push(row);
    groups.set(key, existing);
  }
  return groups;
}

// ── Components ────────────────────────────────────────────────────────────────

function KeyBadge({ row }: { row: UsageRow }) {
  const display = row.keyMasked ?? (row.keyLast4 ? `...${row.keyLast4}` : null);
  const label = row.keyLabel ?? keySourceLabel(row.keySource);
  if (!display) {
    return (
      <span className="con-chip">
        <span className="opacity-60">key removed</span>
        <span className="text-[color:var(--con-faint)]">·</span>
        <span>{label}</span>
      </span>
    );
  }
  return (
    <span className="con-chip">
      <span className="con-mono text-[color:var(--con-accent)]">{display}</span>
      <span className="text-[color:var(--con-faint)]">·</span>
      <span>{label}</span>
    </span>
  );
}

function AccountBadge({ row }: { row: UsageRow }) {
  const unattributed = !row.connectedAccountId;
  return (
    <span
      className="con-chip"
      title={unattributed ? "Not attributed to a connected account" : `Account: ${accountLabelText(row)}`}
    >
      <span className="text-[color:var(--con-faint)]">acct</span>
      <span className={unattributed ? "italic" : "font-medium text-[color:var(--con-fg)]"}>{accountLabelText(row)}</span>
    </span>
  );
}

function UsageGroupCard({ groupRows: rows }: { groupRows: UsageRow[] }) {
  const first = rows[0];
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);
  const totalIn = rows.reduce((s, r) => s + r.promptTokens, 0);
  const totalOut = rows.reduce((s, r) => s + r.completionTokens, 0);

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[length:var(--con-fs-sm)] font-semibold">{userLabel(first.userId)}</span>
            <span className="con-chip">{providerLabel(first.provider)}</span>
            <KeyBadge row={first} />
            <AccountBadge row={first} />
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="con-num text-lg font-semibold">{fmtTotalCost(totalCost)}</div>
          <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">{totalCalls} call{totalCalls !== 1 ? "s" : ""}</div>
        </div>
      </div>

      <div className="mb-2 flex gap-4 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
        <span>In: <span className="con-mono text-[color:var(--con-fg)]">{fmtTokens(totalIn)}</span></span>
        <span>Out: <span className="con-mono text-[color:var(--con-fg)]">{fmtTokens(totalOut)}</span></span>
        <span>Total: <span className="con-mono text-[color:var(--con-fg)]">{fmtTokens(totalIn + totalOut)}</span></span>
      </div>

      {/* Per-model / per-context breakdown */}
      <div className="mt-2 space-y-1 border-t border-[color:var(--con-line)] pt-2">
        {rows
          .slice()
          .sort((a, b) => b.costUsd - a.costUsd)
          .map((r, i) => (
            <div key={i} className="flex items-center justify-between text-[length:var(--con-fs-xs)]">
              <div className="flex items-center gap-2 text-[color:var(--con-muted)]">
                <span className="con-mono text-[color:var(--con-fg)]">{r.model ?? "—"}</span>
                <span className="text-[color:var(--con-faint)]">·</span>
                <span title={r.context ?? "unknown"}>{llmUsageContextLabel(r.context ?? "unknown")}</span>
                <span className="text-[color:var(--con-faint)]">·</span>
                <span>{r.calls} call{r.calls !== 1 ? "s" : ""}</span>
              </div>
              <div className="con-mono flex items-center gap-3 text-[color:var(--con-muted)]">
                <span title="prompt tokens">{fmtTokens(r.promptTokens)}↑</span>
                <span title="completion tokens">{fmtTokens(r.completionTokens)}↓</span>
                <span className="text-[color:var(--con-fg)]">{fmtCost(r.costUsd)}</span>
              </div>
            </div>
          ))}
      </div>
    </Card>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

const WINDOW_OPTIONS = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

export function LlmUsageClient({
  endpoint = "/api/admin/llm-usage",
  scope = "admin",
  title = "LLM usage & cost"
}: {
  endpoint?: string;
  scope?: "admin" | "user";
  /** h1 text. Defaults to the admin mount's own title; the console mount
   *  (/console/usage) overrides this to "Usage" so the h1 matches the nav
   *  rail label (destinationLabel in app/console/components/nav.tsx). */
  title?: string;
}) {
  const [days, setDays] = useState(30);
  const [operatorOnly, setOperatorOnly] = useState(false);
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ProbeErrorDescription | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ sinceDays: String(days) });
      if (scope === "admin" && operatorOnly) params.set("operatorFundedOnly", "true");
      const res = await fetch(`${endpoint}?${params}`);
      if (!res.ok) {
        // "admin" scope hits requireAdmin-gated routes (a 403 means no admin identity);
        // "user" scope (/console/usage → /api/llm-usage) has no admin gate, so wording
        // there shouldn't claim operator access is the problem.
        setError(describeProbeStatus(res.status, scope === "admin" ? "operator" : "generic"));
        return;
      }
      setData(await res.json());
    } catch {
      setError(describeProbeNetworkError());
    } finally {
      setLoading(false);
    }
  }, [days, endpoint, operatorOnly, scope]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Distinct accounts present in this window (incl. an "Unattributed" bucket) drive the filter.
  const accountOptions = data
    ? Array.from(new Map(data.rows.map((r) => [r.connectedAccountId ?? "unattributed", r] as const)).values())
        .map((r) => ({ value: r.connectedAccountId ?? "unattributed", label: accountLabelText(r) }))
        .sort((a, b) => a.label.localeCompare(b.label))
    : [];
  const filteredRows = data
    ? data.rows.filter(
        (r) =>
          accountFilter === "all" ||
          (accountFilter === "unattributed" ? !r.connectedAccountId : r.connectedAccountId === accountFilter)
      )
    : [];
  const groups = groupRows(filteredRows);
  const groupList = Array.from(groups.entries())
    .map(([, rows]) => rows)
    .sort((a, b) =>
      b.reduce((s: number, r: UsageRow) => s + r.costUsd, 0) -
      a.reduce((s: number, r: UsageRow) => s + r.costUsd, 0)
    );
  const filteredTotalCost = filteredRows.reduce((s, r) => s + r.costUsd, 0);
  const filteredFailoverCost = filteredRows.filter((r) => r.keySource === "operator").reduce((s, r) => s + r.costUsd, 0);
  const filteredCalls = filteredRows.reduce((s, r) => s + r.calls, 0);
  const filteredTokens = filteredRows.reduce((s, r) => s + r.totalTokens, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          {scope === "admin" ? "Per-key, per-model, per-context breakdown across all LLM calls." : "Your per-key, per-model, per-context LLM usage."}
        </p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={String(days)}
          onChange={(v) => setDays(Number(v))}
          ariaLabel="Time window"
          options={WINDOW_OPTIONS.map((opt) => ({ value: String(opt.days), label: opt.label }))}
        />
        {scope === "admin" && (
          <div className="flex select-none items-center gap-2 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            <Toggle checked={operatorOnly} onChange={setOperatorOnly} label="Server-failover only" />
            Server-failover only
          </div>
        )}
        {accountOptions.length > 1 && (
          /* con-select is width:100% (unlayered CSS beats Tailwind's w-auto), so size via a wrapper. */
          <div className="w-56">
            <Select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              aria-label="Filter by account"
            >
              <option value="all">All accounts</option>
              {accountOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          </div>
        )}
        <Btn variant="outline" size="sm" className="ml-auto" onClick={fetchData} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </Btn>
      </div>

      {error && (
        <div
          className="rounded-[var(--con-radius-sm)] border border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] p-3 text-[length:var(--con-fs-sm)] text-[color:var(--con-neg)]"
          title={error.rawLabel}
        >
          {error.message}
        </div>
      )}

      {data && (
        <>
          {/* Summary row */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="con-tile">
              <Stat
                label="Total cost"
                value={fmtTotalCost(filteredTotalCost)}
                sub={accountFilter === "all" ? `last ${days}d` : `filtered · ${days}d`}
              />
            </div>
            <div className="con-tile">
              <Stat
                label="Server failover"
                value={fmtTotalCost(filteredFailoverCost)}
                sub={data.operatorFallbackEnabled ? "failover on" : "failover off"}
              />
            </div>
            <div className="con-tile">
              <Stat
                label="Key × account"
                value={String(groups.size)}
                sub={scope === "admin" ? "all visible" : "yours"}
              />
            </div>
            <div className="con-tile">
              <Stat
                label="Total calls"
                value={fmtTokens(filteredCalls)}
                sub={`${fmtTokens(filteredTokens)} tokens`}
              />
            </div>
          </div>

          {/* Per-key groups */}
          {groupList.length === 0 ? (
            <div className="py-12 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">No usage recorded in this window.</div>
          ) : (
            <div className="space-y-3">
              {groupList.map((rows, i) => (
                <UsageGroupCard key={i} groupRows={rows} />
              ))}
            </div>
          )}

          {data.operatorFundedTenants.length > 0 && (
            <div className="con-tile text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              Server-failover usage: {data.operatorFundedTenants.map(userLabel).join(", ")}
            </div>
          )}
        </>
      )}

      {loading && !data && (
        <div className="py-12 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">Loading…</div>
      )}
    </div>
  );
}
