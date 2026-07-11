"use client";

/** Model stats drawer — the info affordance next to the Proposer/Reviewer model
 *  pickers on the Framework (strategy) page. One small button per select opens
 *  a sheet listing every catalog model with cost per call and latency (live
 *  figures when this user has enough real traffic, otherwise the standardized
 *  offline benchmark — the 2026-07-08 full sweep, topped up 2026-07-10 for
 *  Mistral once its capability-map bug was fixed — always labeled which is
 *  which) plus a performance column whose meaning is role-specific. Neither
 *  performance measure is shown unlabeled below its sample-size thresholds.
 *  - Proposer (Green): realized performance = closed trades whose ENTRY this
 *    model proposed. Hidden below 20 closed trades ("needs >= 20 closed trades
 *    (n=X)"); 20-49 shows numbers WITH a small-sample caveat; 50+ plain.
 *  - Reviewer (Red): veto value-add = the counterfactual "had-it-run" outcome
 *    of the risk-adding proposals this model vetoed (share whose forward return
 *    was a loss — a good veto avoids a loser — plus the average counterfactual
 *    return, where NEGATIVE = value added). Fed by getRedTeamEfficacy(userId)
 *    .byModel; gated on 20/50 MATURED vetoes with the same helpers as the
 *    Results page 'Red Team veto efficacy' scorecard. Same measure, per model. */

import { useCallback, useState } from "react";
import { BarChart2 } from "lucide-react";
// Pure curated-model DATA (no legacy UI components) — same import the strategy
// page already uses, so the drawer lists exactly what the dropdowns offer.
import { CURATED_LLM_MODEL_GROUPS } from "../../ui/llm-model-catalog";
// Reuse the SAME veto-value-add gates + tone the Results page 'Red Team veto efficacy'
// scorecard uses, so the drawer and the scorecard never drift apart. Do NOT redefine these.
import {
  RED_TEAM_EFFICACY_MIN_RESOLVED,
  redTeamReturnTone,
  redTeamSampleGate,
  redTeamSampleTier // encapsulates the 20/50 (MIN/SOLID) matured-veto thresholds
} from "../lib/red-team-efficacy";
import { Chip, Dash, IconButton, TONE_VAR } from "../ui/primitives";
import { Sheet } from "../ui/sheet";

type PickerRole = "proposer" | "red-team";

interface ModelPerf {
  closedTrades: number;
  winRate: number;
  avgPnlPct: number;
  totalPnlUsd: number;
}

// Mirrors src/lib/model-stats.ts ReviewerPerf verbatim (the drawer hand-duplicates the
// route's response shapes). NOT win-rate: veto value-add is the counterfactual outcome of
// the proposals this reviewer vetoed — negative avgReturnPct = the veto avoided losses.
interface ReviewerPerf {
  maturedVetoes: number;
  vetoValueAddRate: number;
  survivorRiskHitRate: number;
  avgReturnPct: number;
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
  reviewerPerf: ReviewerPerf | null;
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
        <Chip title="Estimated cost per call from a standardized offline benchmark run — not your live traffic.">benchmark</Chip>
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
        <Chip title="Cold-start p50 from a standardized offline benchmark run — not your live traffic.">benchmark</Chip>
      </span>
    );
  }
  return <Dash />;
}

/** Reviewer (Red Team) veto value-add — the RED-role 4th column. NOT win-rate: it reports the
 *  counterfactual outcome of the proposals this model vetoed. HIGHER good-veto % is better, and
 *  a NEGATIVE avg counterfactual return is GOOD (the veto avoided losses), so the avg is toned
 *  via redTeamReturnTone (negative → the positive/"pos" tone). Gated on 20/50 matured vetoes
 *  with the same helpers as the Results page 'Red Team veto efficacy' scorecard. */
function ReviewerPerfCell({ s }: { s: ModelRoleStats | undefined }) {
  const n = s?.reviewerPerf?.maturedVetoes ?? 0;
  if (!s || !s.reviewerPerf || n < RED_TEAM_EFFICACY_MIN_RESOLVED) {
    return <span className="whitespace-nowrap text-[color:var(--con-faint)]">— {redTeamSampleGate(n)}</span>;
  }
  const { vetoValueAddRate, avgReturnPct } = s.reviewerPerf;
  const avgTone = redTeamReturnTone(avgReturnPct);
  const tier = redTeamSampleTier(n);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="con-num">
        {vetoValueAddRate.toFixed(0)}% good vetoes · avg{" "}
        <span style={avgTone === "muted" ? undefined : { color: TONE_VAR[avgTone] }}>{fmtSignedPct(avgReturnPct)}</span>
      </span>
      {tier === "caution" ? (
        <Chip tone="warn" title={`Only ${n} matured vetoes — treat this as an early read, not an established edge.`}>
          {redTeamSampleGate(n)}
        </Chip>
      ) : (
        <Chip title={`${n} matured blocking vetoes attributed to this reviewer model; negative avg = losses avoided.`}>
          {redTeamSampleGate(n)}
        </Chip>
      )}
    </span>
  );
}

function PerfCell({ s, role }: { s: ModelRoleStats | undefined; role: PickerRole }) {
  if (role === "red-team") return <ReviewerPerfCell s={s} />;
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
  const roleLabel = role === "proposer" ? "Proposer (Green)" : "Reviewer (Red)";

  return (
    <>
      <IconButton label={`Model stats — cost, latency and realized performance for every ${roleLabel} option.`} onClick={openDrawer}>
        <BarChart2 size={15} />
      </IconButton>
      <Sheet open={open} onClose={() => setOpen(false)} title={`Model stats — ${roleLabel}`} wide>
        <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Cost and latency per call for every model in this picker. Figures marked <strong>live</strong> come from your own
          recent calls in this role{data ? ` (last ${data.sinceDays} days)` : ""}; models without enough live traffic fall
          back to a standardized offline <strong>benchmark</strong> run{data ? ` (most recently updated ${new Date(data.benchmark.runAt).toLocaleDateString()})` : ""}.
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
                  <th className="text-left">{role === "proposer" ? "Realized performance" : "Veto value-add"}</th>
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
                Veto value-add = of the risk-adding proposals this model vetoed, the share whose counterfactual
                (had-it-run) outcome was a loss — a good veto avoids a loser — and the average counterfactual return
                (negative = value added). A veto resolves ~5 trading days after it&apos;s made; hidden until 20 resolved
                vetoes, small-sample caveat until 50. Same measure as the Results page &apos;Red Team veto efficacy&apos;
                scorecard, per model.
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
