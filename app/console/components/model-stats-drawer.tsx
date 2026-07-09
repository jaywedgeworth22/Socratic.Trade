"use client";

/** Model stats drawer — the info affordance next to the Proposer/Reviewer model
 *  pickers (settings/models + strategy page). One small button per select opens
 *  a sheet listing every catalog model with cost per call and latency (live
 *  figures when this user has enough real traffic, otherwise the 2026-07-08
 *  benchmark, always labeled which is which) plus realized performance for the
 *  Proposer role. Performance is never shown unlabeled below its sample-size
 *  thresholds: under 20 closed trades it stays hidden behind an explicit
 *  "needs >= 20 closed trades (n=X)"; 20-49 shows numbers WITH a small-sample
 *  caveat; 50+ shows them plain. Reviewer performance is per-run (veto
 *  value-add), not per-trade, so that column stays a dash with a footnote
 *  rather than a faked number. */

import { useCallback, useState } from "react";
import { BarChart2 } from "lucide-react";
// Pure curated-model DATA (no legacy UI components) — same import the strategy
// page already uses, so the drawer lists exactly what the dropdowns offer.
import { CURATED_LLM_MODEL_GROUPS } from "../../ui/llm-model-catalog";
import { Chip, Dash, IconButton } from "../ui/primitives";
import { Sheet } from "../ui/sheet";

type PickerRole = "proposer" | "red-team";

interface ModelPerf {
  closedTrades: number;
  winRate: number;
  avgPnlPct: number;
  totalPnlUsd: number;
}

interface ModelRoleStats {
  model: string;
  role: "green" | "red";
  liveCalls: number;
  avgCostUsd: number | null;
  p50LatencyMs: number | null;
  latencySamples: number;
  benchmarkCostUsd: number | null;
  benchmarkColdP50Ms: number | null;
  closedTrades: number;
  perf: ModelPerf | null;
}

interface ModelStatsResponse {
  sinceDays: number;
  benchmark: { runAt: string; source: string };
  stats: ModelRoleStats[];
}

/** Live figures need at least this many samples before they outrank the benchmark. */
const LIVE_MIN_SAMPLES = 3;
/** Below this many closed trades, realized performance stays hidden behind an explicit label. */
const PERF_MIN_TRADES = 20;
/** Between PERF_MIN_TRADES and this, performance shows WITH a small-sample caveat. */
const PERF_SOLID_TRADES = 50;

function fmtCost(v: number): string {
  return v >= 0.1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

function fmtLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function fmtSignedPct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function CostCell({ s }: { s: ModelRoleStats | undefined }) {
  if (s && s.liveCalls >= LIVE_MIN_SAMPLES && s.avgCostUsd !== null) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="con-num">{fmtCost(s.avgCostUsd)}</span>
        <Chip tone="accent" title={`Average cost per call over your last ${s.liveCalls} real calls in this role.`}>
          live · n={s.liveCalls}
        </Chip>
      </span>
    );
  }
  if (s && s.benchmarkCostUsd !== null) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="con-num">{fmtCost(s.benchmarkCostUsd)}</span>
        <Chip title="Estimated cost per call from the 2026-07-08 standardized benchmark run — not your live traffic.">benchmark</Chip>
      </span>
    );
  }
  return <Dash />;
}

function LatencyCell({ s }: { s: ModelRoleStats | undefined }) {
  if (s && s.latencySamples >= LIVE_MIN_SAMPLES && s.p50LatencyMs !== null) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="con-num">{fmtLatency(s.p50LatencyMs)}</span>
        <Chip tone="accent" title={`Median (p50) of your last ${s.latencySamples} successful real calls in this role.`}>
          live · n={s.latencySamples}
        </Chip>
      </span>
    );
  }
  if (s && s.benchmarkColdP50Ms !== null) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <span className="con-num">{fmtLatency(s.benchmarkColdP50Ms)}</span>
        <Chip title="Cold-start p50 from the 2026-07-08 standardized benchmark run — not your live traffic.">benchmark</Chip>
      </span>
    );
  }
  return <Dash />;
}

function PerfCell({ s, role }: { s: ModelRoleStats | undefined; role: PickerRole }) {
  if (role === "red-team") return <Dash />;
  const n = s?.closedTrades ?? 0;
  if (!s || n < PERF_MIN_TRADES || !s.perf) {
    return (
      <span className="whitespace-nowrap text-[color:var(--con-faint)]">
        — needs ≥{PERF_MIN_TRADES} closed trades (n={n})
      </span>
    );
  }
  const { winRate, avgPnlPct } = s.perf;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="con-num">
        {winRate.toFixed(0)}% win · avg {fmtSignedPct(avgPnlPct)}
      </span>
      {n < PERF_SOLID_TRADES ? (
        <Chip tone="warn" title={`Only ${n} closed trades — treat this as an early read, not an established edge.`}>
          small sample (n={n})
        </Chip>
      ) : (
        <Chip title={`${n} closed trades attributed to entries this model proposed.`}>n={n}</Chip>
      )}
    </span>
  );
}

/** Small stats button + drawer for ONE picker. `role` picks which side of the
 *  per-(model, role) stats to show: proposer = green, red-team = red. */
export function ModelStatsButton({ role }: { role: PickerRole }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ModelStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const openDrawer = useCallback(() => {
    setOpen(true);
    if (data || loading) return;
    setLoading(true);
    fetch("/api/llm-usage/model-stats")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Stats unavailable (${res.status}).`);
        setData((await res.json()) as ModelStatsResponse);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [data, loading]);

  const statsRole = role === "proposer" ? "green" : "red";
  const byModel = new Map((data?.stats ?? []).filter((s) => s.role === statsRole).map((s) => [s.model, s]));
  const roleLabel = role === "proposer" ? "Proposer (Green Team)" : "Reviewer (Red Team)";

  return (
    <>
      <IconButton label={`Model stats — cost, latency and realized performance for every ${roleLabel} option.`} onClick={openDrawer}>
        <BarChart2 size={15} />
      </IconButton>
      <Sheet open={open} onClose={() => setOpen(false)} title={`Model stats — ${roleLabel}`} wide>
        <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Cost and latency per call for every model in this picker. Figures marked <strong>live</strong> come from your own
          recent calls in this role{data ? ` (last ${data.sinceDays} days)` : ""}; models without enough live traffic fall
          back to the standardized <strong>benchmark</strong> run{data ? ` of ${new Date(data.benchmark.runAt).toLocaleDateString()}` : ""}.
        </p>
        {loading && <p className="py-4 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">Loading model stats…</p>}
        {error && !loading && (
          <p className="rounded-lg border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] p-2.5 text-[length:var(--con-fs-xs)]">
            {error}
          </p>
        )}
        {data && !loading && (
          <div className="overflow-x-auto">
            <table className="con-table w-full">
              <thead>
                <tr>
                  <th className="text-left">Model</th>
                  <th className="text-left">Cost / call</th>
                  <th className="text-left">Latency (p50)</th>
                  <th className="text-left">Realized performance</th>
                </tr>
              </thead>
              <tbody>
                {CURATED_LLM_MODEL_GROUPS.map((group) => (
                  <ProviderRows key={group.provider} label={group.label} models={group.options.map((o) => o.value)} byModel={byModel} role={role} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && !loading && (
          <p className="mt-3 text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">
            {role === "proposer" ? (
              <>
                Realized performance = closed trades whose ENTRY this model proposed (win rate and average return per closed
                lot, all your accounts). Hidden until 20 closed trades exist; shown with a small-sample caveat until 50.
              </>
            ) : (
              <>
                Reviewer performance isn&apos;t scored per trade yet: Red attribution is per-run (veto value-add on the
                proposals it kills), a different measure from closed-trade P&amp;L — see the Results page scorecards.
              </>
            )}
          </p>
        )}
      </Sheet>
    </>
  );
}

function ProviderRows({
  label,
  models,
  byModel,
  role
}: {
  label: string;
  models: string[];
  byModel: Map<string, ModelRoleStats>;
  role: PickerRole;
}) {
  return (
    <>
      <tr>
        <td colSpan={4} className="pt-2 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-muted)]">
          {label}
        </td>
      </tr>
      {models.map((model) => {
        const s = byModel.get(model);
        return (
          <tr key={model}>
            <td className="whitespace-nowrap font-medium">{model}</td>
            <td>
              <CostCell s={s} />
            </td>
            <td>
              <LatencyCell s={s} />
            </td>
            <td>
              <PerfCell s={s} role={role} />
            </td>
          </tr>
        );
      })}
    </>
  );
}
