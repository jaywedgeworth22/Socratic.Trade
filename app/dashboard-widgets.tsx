"use client";

import { CheckCircle, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  EquityCurvePoint,
  EquityPosition,
  NotificationEvent,
  PerformanceSummary,
  Portfolio,
  ScoringWeights
} from "@/lib/types";

export const ALLOC_COLORS = ["#245a9d", "#116b4b", "#7c5cbf", "#c27a1e", "#1e7ec2", "#8a5c3e", "#5c8a3e", "#9d4524"];

export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function NumberField({ label, value, onCommit }: { label: string; value?: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value ?? 0));
  useEffect(() => setDraft(String(value ?? 0)), [value]);
  return (
    <label>
      {label}
      <input
        type="number"
        min="0"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => onCommit(Number(draft))}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </label>
  );
}

export function SymbolTagInput({
  disabled,
  values,
  onCommit
}: {
  disabled?: boolean;
  values: string[];
  onCommit: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const normalized = useMemo(() => normalizeSymbols(values), [values]);

  function addDraft() {
    const next = normalizeSymbols([...normalized, ...draft.split(/[,\s]+/)]);
    setDraft("");
    onCommit(next);
  }

  function remove(symbol: string) {
    onCommit(normalized.filter((item) => item !== symbol));
  }

  return (
    <div className="tag-input">
      <div className="tag-list">
        {normalized.map((symbol) => (
          <button key={symbol} type="button" className="tag-chip" disabled={disabled} onClick={() => remove(symbol)} title={`Remove ${symbol}`}>
            {symbol}
            <XCircle size={13} />
          </button>
        ))}
      </div>
      <input
        disabled={disabled}
        value={draft}
        onChange={(event) => setDraft(event.target.value.toUpperCase())}
        onBlur={addDraft}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            addDraft();
          }
        }}
        placeholder="Add ticker, press Enter"
      />
    </div>
  );
}

export function PerformancePanel({ performance, mode }: { performance?: PerformanceSummary; mode: "paper" | "live" }) {
  const curve = mode === "paper" ? performance?.paperEquityCurve ?? [] : performance?.liveEquityCurve ?? [];
  const realizedPnl = mode === "paper" ? performance?.paperRealizedPnl ?? 0 : performance?.liveRealizedPnl ?? 0;
  const unrealizedPnl = mode === "paper" ? performance?.paperUnrealizedPnl ?? 0 : performance?.liveUnrealizedPnl ?? 0;
  const winRate = mode === "paper" ? performance?.paperWinRate ?? 0 : performance?.liveWinRate ?? 0;
  const averageReturn = mode === "paper" ? performance?.paperAverageReturnPct ?? 0 : performance?.liveAverageReturnPct ?? 0;
  const label = mode === "paper" ? "Paper" : "Live";
  const last = lastPoint(curve);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{label} Performance</h2>
      </div>
      {!performance || curve.length === 0 ? (
        <p className="subtle">
          {mode === "paper"
            ? "No Paper performance history yet. Paper trades will update this pretend portfolio immediately."
            : "No Live performance history yet. Live orders and broker snapshots will appear here."}
        </p>
      ) : (
        <div className="performance-grid">
          <div className="chart-card wide">
            <div className="chart-head">
              <strong>Equity Curve</strong>
              <span>{label} {money(last?.equity)}</span>
            </div>
            <LineChart series={[curve]} />
          </div>
          <Metric label="Realized" value={signedMoney(realizedPnl)} />
          <Metric label="Unrealized" value={signedMoney(unrealizedPnl)} />
          <Metric label="Win Rate" value={`${winRate.toFixed(0)}%`} />
          <Metric label="Avg Return" value={`${averageReturn.toFixed(2)}%`} />
        </div>
      )}
    </section>
  );
}

export function AllocationDonut({ positions, portfolio }: { positions: EquityPosition[]; portfolio?: Portfolio }) {
  const total = portfolio?.totalMarketValue ?? 0;
  if (total <= 0) return <p className="subtle">No allocation data yet.</p>;
  const equityValue = positions.reduce((sum, position) => sum + position.marketValue, 0);
  const cashValue = Math.max(0, total - equityValue);
  const segments = [
    ...positions.map((position, index) => ({
      label: position.symbol,
      pct: (position.marketValue / total) * 100,
      color: ALLOC_COLORS[index % ALLOC_COLORS.length]
    })),
    { label: "Cash", pct: (cashValue / total) * 100, color: "#c8ccc8" }
  ].filter((segment) => segment.pct > 0.05);

  return (
    <div className="allocation-chart">
      <DonutChart segments={segments} />
      <div className="alloc-legend">
        {segments.map((segment) => (
          <span key={segment.label} className="alloc-legend-item">
            <span className="alloc-dot" style={{ background: segment.color }} />
            {segment.label} {segment.pct.toFixed(1)}%
          </span>
        ))}
      </div>
    </div>
  );
}

export function NotificationPanel({ notifications, configured }: { notifications: NotificationEvent[]; configured: boolean }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Notifications</h2>
        <span className={`status-badge ${configured ? "status-completed" : "status-running"}`}>
          {configured ? "webhook on" : "audit only"}
        </span>
      </div>
      {notifications.length === 0 ? (
        <p className="subtle">No notification attempts recorded.</p>
      ) : (
        <div className="notification-list">
          {notifications.slice(0, 8).map((event) => (
            <div key={event.id} className="notification-row">
              {event.status === "sent" ? <CheckCircle size={15} /> : event.status === "failed" ? <XCircle size={15} /> : <span className="dot-muted" />}
              <strong>{event.title}</strong>
              <span>{event.status}{event.error ? ` · ${event.error}` : ""}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function ScoringWeightsEditor({
  weights,
  onCommit
}: {
  weights: ScoringWeights;
  onCommit: (weights: ScoringWeights) => void;
}) {
  const keys = Object.keys(weights) as Array<keyof ScoringWeights>;
  return (
    <div className="weight-grid">
      {keys.map((key) => (
        <NumberField
          key={key}
          label={labelize(key)}
          value={weights[key]}
          onCommit={(value) => onCommit({ ...weights, [key]: value })}
        />
      ))}
    </div>
  );
}

function LineChart({ series }: { series: EquityCurvePoint[][] }) {
  const points = series.flat();
  if (points.length === 0) return <div className="empty-chart">No curve yet</div>;
  const width = 560;
  const height = 180;
  const min = Math.min(...points.map((point) => point.equity));
  const max = Math.max(...points.map((point) => point.equity));
  const span = Math.max(1, max - min);
  const pathFor = (items: EquityCurvePoint[]) =>
    items
      .map((point, index) => {
        const x = items.length <= 1 ? width / 2 : (index / (items.length - 1)) * width;
        const y = height - ((point.equity - min) / span) * (height - 16) - 8;
        return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join(" ");
  return (
    <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Equity curve chart">
      <path d={pathFor(series[0] ?? [])} fill="none" stroke="#245a9d" strokeWidth="3" />
      <path d={pathFor(series[1] ?? [])} fill="none" stroke="#116b4b" strokeWidth="3" strokeDasharray="6 4" />
    </svg>
  );
}

function DonutChart({ segments }: { segments: Array<{ label: string; pct: number; color: string }> }) {
  let offset = 25;
  return (
    <svg className="donut-chart" viewBox="0 0 42 42" role="img" aria-label="Allocation donut chart">
      <circle cx="21" cy="21" r="15.915" fill="transparent" stroke="#eef1ec" strokeWidth="8" />
      {segments.map((segment) => {
        const dash = `${segment.pct} ${100 - segment.pct}`;
        const currentOffset = offset;
        offset -= segment.pct;
        return (
          <circle
            key={segment.label}
            cx="21"
            cy="21"
            r="15.915"
            fill="transparent"
            stroke={segment.color}
            strokeWidth="8"
            strokeDasharray={dash}
            strokeDashoffset={currentOffset}
          />
        );
      })}
    </svg>
  );
}

function lastPoint(points?: EquityCurvePoint[]) {
  return points && points.length > 0 ? points[points.length - 1] : undefined;
}

function normalizeSymbols(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim().toUpperCase()).filter((value) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(value))));
}

function labelize(value: string): string {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}

export function money(value?: number) {
  if (typeof value !== "number") return "$0.00";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export function signedMoney(value?: number) {
  const amount = money(value ?? 0);
  return (value ?? 0) >= 0 ? `+${amount}` : amount;
}

export function formatPct(value?: number) {
  if (typeof value !== "number") return "0.00%";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function compactNum(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

export function compactMoney(value: number): string {
  if (value >= 1_000_000_000_000) return `$${(value / 1_000_000_000_000).toFixed(1)}T`;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  return `$${value.toFixed(0)}`;
}
