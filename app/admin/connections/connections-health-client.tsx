"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, Chip, Dot, Segmented } from "../../console/ui/primitives";
import { cx } from "../../console/lib/format";
import { describeProbeNetworkError, describeProbeStatus, type ProbeErrorDescription } from "../lib/probe-error";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ServiceHealthSummary {
  service: string;
  keySource: string | null;
  lastSuccessTs: string | null;
  lastSuccessLatencyMs: number | null;
  lastFailureTs: string | null;
  lastFailureError: string | null;
  callsLastHour: number;
  callsLast24h: number;
  stoppedWorking: boolean;
  stoppedReason: string | null;
}

interface HealthLogRow {
  id: string;
  service: string;
  ts: string;
  ok: number;
  latency_ms: number | null;
  error_text: string | null;
}

interface ErrorPatternRow {
  id: string;
  service: string;
  fingerprint: string;
  error_text: string;
  first_seen: string;
  last_seen: string;
  count: number;
  key_source: string | null;
}

interface HealthData {
  services: ServiceHealthSummary[];
  errorPatterns: Record<string, ErrorPatternRow[]>;
  asOf: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function statusTone(s: ServiceHealthSummary): "pos" | "neg" | "warn" | "muted" {
  if (s.stoppedWorking) return "neg";
  if (!s.lastSuccessTs) return s.callsLast24h > 0 ? "warn" : "muted";
  if (s.lastFailureTs && s.lastFailureTs > s.lastSuccessTs) return "warn";
  return "pos";
}

// ── Service card ──────────────────────────────────────────────────────────────

function ServiceCard({
  summary,
  onClick,
  selected,
}: {
  summary: ServiceHealthSummary;
  onClick: () => void;
  selected: boolean;
}) {
  const tone = statusTone(summary);

  // Hand-authored card recipe (not .con-card): the con-card class sets
  // background/border in unlayered CSS, which beats Tailwind's layered
  // utilities — so the selected/hover tints would silently never apply.
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "w-full rounded-[var(--con-radius)] border p-4 text-left shadow-[var(--con-shadow)] transition-colors",
        selected
          ? "border-[color:var(--con-accent)] bg-[color:var(--con-accent-soft)]"
          : "border-[color:var(--con-line)] bg-[color:var(--con-surface)] hover:bg-[color:var(--con-surface-2)]"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Dot tone={tone} pulse={summary.stoppedWorking} />
          <span className="truncate text-[length:var(--con-fs-sm)] font-medium">
            {summary.service}
            {summary.keySource && (
              <span className="ml-1 text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-muted)]">({summary.keySource})</span>
            )}
          </span>
        </div>
        {summary.stoppedWorking && (
          <Chip tone="neg">STOPPED</Chip>
        )}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
        <span>Last OK: <span className="text-[color:var(--con-fg)]">{relTime(summary.lastSuccessTs)}</span></span>
        <span>Last fail: <span className="text-[color:var(--con-fg)]">{relTime(summary.lastFailureTs)}</span></span>
        <span>1h calls: <span className="text-[color:var(--con-fg)]">{summary.callsLastHour}</span></span>
        <span>24h calls: <span className="text-[color:var(--con-fg)]">{summary.callsLast24h}</span></span>
      </div>

      {summary.lastSuccessLatencyMs !== null && (
        <div className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Last latency: {summary.lastSuccessLatencyMs}ms
        </div>
      )}

      {summary.stoppedWorking && summary.stoppedReason && (
        <div className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-neg)]">{summary.stoppedReason}</div>
      )}
    </button>
  );
}

// ── Detail drawer ─────────────────────────────────────────────────────────────

type DrawerTab = "log" | "errors";

function ServiceDetail({
  summary,
  errorPatterns,
  asOf,
}: {
  summary: ServiceHealthSummary;
  errorPatterns: ErrorPatternRow[];
  asOf: string;
}) {
  const [tab, setTab] = useState<DrawerTab>("log");
  const [log, setLog] = useState<HealthLogRow[]>([]);
  const [loadingLog, setLoadingLog] = useState(false);

  useEffect(() => {
    if (tab !== "log") return;
    setLoadingLog(true);
    const ksParam = summary.keySource !== null ? `&keySource=${encodeURIComponent(summary.keySource)}` : "&keySource=";
    fetch(`/api/admin/connections-health?service=${encodeURIComponent(summary.service)}&limit=100${ksParam}`)
      .then((r) => r.json())
      .then((data) => setLog(data.log ?? []))
      .catch(() => setLog([]))
      .finally(() => setLoadingLog(false));
  }, [summary.service, summary.keySource, tab, asOf]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[length:var(--con-fs-sm)] font-semibold">
          {summary.service}
          {summary.keySource && (
            <span className="ml-1.5 text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-muted)]">({summary.keySource})</span>
          )}
        </h3>
        <Segmented<DrawerTab>
          value={tab}
          onChange={setTab}
          ariaLabel="Service detail view"
          options={[
            { value: "log", label: "Raw Log" },
            { value: "errors", label: `Error Patterns (${errorPatterns.length})` },
          ]}
        />
      </div>

      {tab === "log" && (
        <div className="overflow-x-auto rounded-[var(--con-radius-sm)] border border-[color:var(--con-line)]">
          {loadingLog ? (
            <div className="py-8 text-center text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">Loading…</div>
          ) : log.length === 0 ? (
            <div className="py-8 text-center text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">No log entries</div>
          ) : (
            <table className="con-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Status</th>
                  <th className="num">Latency</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {log.map((row) => (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap text-[color:var(--con-faint)]">{relTime(row.ts)}</td>
                    <td>
                      {row.ok ? (
                        <Chip tone="pos">OK</Chip>
                      ) : (
                        <Chip tone="neg">FAIL</Chip>
                      )}
                    </td>
                    <td className="num text-[color:var(--con-muted)]">
                      {row.latency_ms !== null ? `${row.latency_ms}ms` : "—"}
                    </td>
                    <td className="max-w-xs truncate text-[color:var(--con-neg)]">
                      {row.error_text ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "errors" && (
        <div className="overflow-x-auto rounded-[var(--con-radius-sm)] border border-[color:var(--con-line)]">
          {errorPatterns.length === 0 ? (
            <div className="py-8 text-center text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">No error patterns</div>
          ) : (
            <table className="con-table">
              <thead>
                <tr>
                  <th>Error</th>
                  <th className="num">Count</th>
                  <th>First seen</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {errorPatterns.map((p) => (
                  <tr key={p.id}>
                    <td className="con-mono max-w-xs truncate text-[color:var(--con-neg)]">{p.error_text}</td>
                    <td className="num font-semibold">{p.count}</td>
                    <td className="whitespace-nowrap text-[color:var(--con-faint)]">{relTime(p.first_seen)}</td>
                    <td className="whitespace-nowrap text-[color:var(--con-faint)]">{relTime(p.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ConnectionsHealthClient() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ProbeErrorDescription | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/connections-health");
      if (!r.ok) {
        setError(describeProbeStatus(r.status));
        return;
      }
      const d: HealthData = await r.json();
      setData(d);
      setError(null);
    } catch {
      setError(describeProbeNetworkError());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch_();
    const interval = setInterval(fetch_, 30_000);
    return () => clearInterval(interval);
  }, [fetch_]);

  const laneKey = (s: ServiceHealthSummary) => `${s.service}:${s.keySource ?? ""}`;
  const selectedSummary = data?.services.find((s) => laneKey(s) === selected) ?? null;
  const stoppedCount = data?.services.filter((s) => s.stoppedWorking).length ?? 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">API Connections</h1>
          {data?.asOf && (
            <p className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">Last updated {relTime(data.asOf)}</p>
          )}
        </div>
        {stoppedCount > 0 && (
          <Chip tone="neg">{stoppedCount} stopped</Chip>
        )}
      </div>

      {loading && !data && (
        <div className="py-16 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">Loading…</div>
      )}

      {error && (
        <div
          className="rounded-[var(--con-radius-sm)] border border-[color:var(--con-neg-border)] bg-[color:var(--con-neg-soft)] p-3 text-[length:var(--con-fs-sm)] text-[color:var(--con-neg)]"
          title={error.rawLabel}
        >
          {error.message}
        </div>
      )}

      {data && (
        <div className={`grid gap-4 ${selectedSummary ? "lg:grid-cols-[380px_1fr]" : "grid-cols-1"}`}>
          {/* Service grid */}
          <div className="space-y-3">
            {data.services.length === 0 ? (
              <Card className="text-center">
                <p className="py-4 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">No API calls recorded yet.</p>
                <p className="pb-4 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  Health data appears after the first scan or enrichment fetch.
                </p>
              </Card>
            ) : (
              <>
                {/* Stopped services first */}
                {data.services
                  .slice()
                  .sort((a, b) => {
                    if (a.stoppedWorking !== b.stoppedWorking) return a.stoppedWorking ? -1 : 1;
                    const svcCmp = a.service.localeCompare(b.service);
                    if (svcCmp !== 0) return svcCmp;
                    return (a.keySource ?? "").localeCompare(b.keySource ?? "");
                  })
                  .map((s) => (
                    <ServiceCard
                      key={laneKey(s)}
                      summary={s}
                      selected={selected === laneKey(s)}
                      onClick={() => setSelected(selected === laneKey(s) ? null : laneKey(s))}
                    />
                  ))}
              </>
            )}
          </div>

          {/* Detail panel */}
          {selectedSummary && (
            <Card className="sticky top-16 self-start">
              <ServiceDetail
                summary={selectedSummary}
                errorPatterns={data.errorPatterns[laneKey(selectedSummary)] ?? []}
                asOf={data.asOf}
              />
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
