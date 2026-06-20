import {
    companyTitle,
    enrichPositionsForDisplay,
    formatShareQuantity
} from "@/lib/dashboard-ui";
import type {
    MarketQuote,
    MarketScan
} from "@/lib/types";
import {
    Wallet
} from "lucide-react";
import { useEffect, useState } from "react";
import type { DashboardSnapshot } from "../../dashboard-types";
import { formatPct, money, signedMoney } from "../../dashboard-widgets";
import { cn } from "../../ui/cn";
import {
    Card,
    Chip,
    EmptyState,
    Field,
    PanelHeader,
    StatTile,
    inputClass
} from "../../ui/primitives";
import { AllocationDonut, EquityCurve, ScorecardBars } from "../charts";
import { resolveScanQuote } from "./utils";
export { AllocationDonut, EquityCurve, ScorecardBars };

export function StatusPill({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex flex-col rounded-lg border border-line bg-surface/50 backdrop-blur-xl px-3 py-1" title={title}>
      <span className="text-[9px] font-semibold uppercase tracking-wide text-faint">{label}</span>
      <span className="tnum text-[13px] leading-tight text-fg">{value}</span>
    </div>
  );
}

export function DailyRiskPill({ pct, used, cap }: { pct: number; used: number; cap: number }) {
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

export function SymbolButton({
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
  const drilldownTarget = quote ?? ({ symbol, price: 0, score: 0, source: "", generatedAt: new Date().toISOString() } as unknown as MarketQuote);
  if (!onDrilldown) {
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
        onDrilldown(drilldownTarget);
      }}
      className={cn(className, interactive)}
    >
      {symbol}
    </button>
  );
}

export function SentimentChip({ value }: { value: number }) {
  const tone = value >= 60 ? "up" : value <= 40 ? "down" : "neutral";
  const label = value >= 60 ? "Positive" : value <= 40 ? "Negative" : "Neutral";
  return <Chip tone={tone}>{label} {value}</Chip>;
}

export function RatingChip({ score, label }: { score?: number; label: string }) {
  // Mirror the Sentiment chip: green for Buy-ish, red for Sell-ish, neutral for Hold.
  const tone = score === undefined ? "neutral" : score >= 65 ? "up" : score <= 40 ? "down" : "neutral";
  return <Chip tone={tone}>{typeof score === "number" ? `${label} ${score}` : label}</Chip>;
}

export function KeyVal({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2">
      <div className="text-[11px] uppercase text-faint">{label}</div>
      <div className="tnum text-sm text-fg">{value}</div>
    </div>
  );
}

export function EditableParam({
  label,
  absValue,
  relValue,
  onCommitAbs,
  onCommitRel,
  defaultMode
}: {
  label: string;
  absValue?: number;
  relValue?: number;
  onCommitAbs: (v: number | undefined) => void;
  onCommitRel: (v: number | undefined) => void;
  defaultMode: "abs" | "rel";
}) {
  const [mode, setMode] = useState<"abs" | "rel">(
    absValue !== undefined ? "abs" : relValue !== undefined ? "rel" : defaultMode
  );
  
  const currentVal = mode === "abs" ? absValue : relValue;
  const [draft, setDraft] = useState(currentVal !== undefined ? String(currentVal) : "");
  
  useEffect(() => {
    const val = mode === "abs" ? absValue : relValue;
    setDraft(val !== undefined ? String(val) : "");
  }, [mode, absValue, relValue]);

  function commit() {
    if (draft.trim() === "") {
      onCommitAbs(undefined);
      onCommitRel(undefined);
      return;
    }
    const n = Number(draft);
    if (Number.isFinite(n) && n >= 0) {
      if (mode === "abs") {
        onCommitAbs(n);
        onCommitRel(undefined);
      } else {
        onCommitAbs(undefined);
        onCommitRel(n);
      }
    } else {
      const val = mode === "abs" ? absValue : relValue;
      setDraft(val !== undefined ? String(val) : "");
    }
  }

  function toggleMode(e: React.MouseEvent) {
    e.preventDefault();
    setMode((prev) => (prev === "abs" ? "rel" : "abs"));
  }

  return (
    <label className="rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2 focus-within:border-accent">
      <div className="flex items-center justify-between text-[11px] uppercase text-faint">
        {label}
        <button type="button" onClick={toggleMode} className="hover:text-fg flex cursor-pointer items-center gap-1 font-semibold transition-colors">
           {mode === "abs" ? "$" : "%"} <span className="text-[9px] opacity-50">⇄</span>
        </button>
      </div>
      <div className="flex items-baseline gap-1">
        {mode === "abs" && <span className="text-sm text-faint shrink-0">$</span>}
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
          className="w-full min-w-0 flex-1 bg-transparent tnum text-sm text-fg outline-none"
          placeholder={mode === "abs" ? "Not set" : "Not set"}
        />
        {mode === "rel" && <span className="text-sm text-faint shrink-0">%</span>}
      </div>
    </label>
  );
}

export function NumberField({ label, value, onCommit }: { label: string; value?: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value ?? 0));
  useEffect(() => setDraft(String(value ?? 0)), [value]);
  return (
    <label className="rounded-lg border border-line bg-surface-2/50 backdrop-blur-lg px-3 py-2 focus-within:border-accent">
      <div className="text-[11px] uppercase text-faint mb-1">{label}</div>
      <input
        type="number"
        min="0"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(Number(draft))}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-full bg-transparent tnum text-sm text-fg outline-none"
      />
    </label>
  );
}

export function RangeField({ label, value, min, max, step, onCommit }: { label: string; value: number; min: number; max: number; step: number; onCommit: (v: number) => void }) {
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

export function PortfolioRail({
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
      <PanelHeader title="Portfolio" subtitle={mode === "paper" ? "Test account" : "Live account"} icon={<Wallet size={16} />} />
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

export const DASH = <span className="text-faint">—</span>;
