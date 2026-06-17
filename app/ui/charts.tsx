"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Brush
} from "recharts";
import type { EquityCurvePoint } from "@/lib/types";

const ALLOC_COLORS = ["#10b981", "#3b82f6", "#8b5cf6", "#f59e0b", "#06b6d4", "#ef4444", "#84cc16", "#ec4899"];

function money(v: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v);
}

const tooltipStyle = {
  background: "var(--surface)",
  border: "1px solid var(--line)",
  borderRadius: "10px",
  fontSize: "12px",
  color: "var(--fg)",
  boxShadow: "var(--shadow)"
} as const;

export function EquityCurve({ data }: { data: EquityCurvePoint[] }) {
  if (data.length === 0) {
    return <div className="flex h-full items-center justify-center text-xs text-faint">No equity history yet</div>;
  }
  const chartData = data.map((p, i) => ({
    i,
    t: new Date(p.timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    equity: p.equity
  }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={chartData} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="i" hide />
        <YAxis
          domain={["dataMin - 1", "dataMax + 1"]}
          width={52}
          stroke="var(--faint)"
          fontSize={11}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => money(Number(v))}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(_label, p) => (Array.isArray(p) && p[0] ? (p[0].payload as { t: string }).t : "")}
          formatter={(v) => [money(Number(v)), "Equity"]}
        />
        <Area type="monotone" dataKey="equity" stroke="var(--accent)" strokeWidth={2} fill="url(#eq)" />
        <Brush dataKey="t" height={30} stroke="var(--muted)" fill="transparent" tickFormatter={() => ""} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function AllocationDonut({
  segments
}: {
  segments: Array<{ label: string; value: number; pct: number }>;
}) {
  if (segments.length === 0) {
    return <div className="flex h-full items-center justify-center text-xs text-faint">No allocation data</div>;
  }
  return (
    <div className="flex items-center gap-4">
      <div className="h-[150px] w-[150px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={segments} dataKey="value" nameKey="label" innerRadius={46} outerRadius={70} paddingAngle={2} stroke="none">
              {segments.map((s, i) => (
                <Cell key={s.label} fill={s.label === "Cash" ? "var(--faint)" : ALLOC_COLORS[i % ALLOC_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} formatter={(v, n) => [money(Number(v)), String(n)]} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((s, i) => (
          <span key={s.label} className="flex items-center gap-1.5 text-xs text-muted">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: s.label === "Cash" ? "var(--faint)" : ALLOC_COLORS[i % ALLOC_COLORS.length] }}
            />
            <span className="text-fg">{s.label}</span>
            <span className="tnum text-faint">{s.pct.toFixed(1)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Learning-loop visualization: realized P&L (or win rate) per thesis/regime bucket. */
export function ScorecardBars({
  data,
  height = 150
}: {
  data: Array<{ label: string; pnl: number; winRate: number; trades: number }>;
  height?: number;
}) {
  if (data.length === 0) {
    return <div className="py-6 text-center text-xs text-faint">No closed trades yet — outcomes appear once positions close.</div>;
  }
  const rows = data.slice(0, 7);
  return (
    <ResponsiveContainer width="100%" height={Math.max(height, rows.length * 30)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }} barCategoryGap={6}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="label"
          width={120}
          stroke="var(--muted)"
          fontSize={11}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          cursor={{ fill: "color-mix(in oklab, var(--muted) 12%, transparent)" }}
          formatter={(v, _n, item) => {
            const row = (item?.payload ?? {}) as { winRate?: number; trades?: number };
            return [`${money(Number(v))} · ${row.winRate ?? 0}% win · ${row.trades ?? 0} trades`, "Realized"];
          }}
        />
        <Bar dataKey="pnl" radius={[0, 4, 4, 0]}>
          {rows.map((r) => (
            <Cell key={r.label} fill={r.pnl >= 0 ? "var(--up)" : "var(--down)"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
