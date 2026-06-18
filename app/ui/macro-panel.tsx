import React from "react";
import { Chip } from "./primitives";
import { Landmark, TrendingUp, Activity, Gauge, Droplets } from "lucide-react";
import type { DashboardSnapshot } from "../dashboard-types";

type Board = NonNullable<DashboardSnapshot["macroBoard"]>;
type Tone = "up" | "down" | "warn" | undefined;
type Tile = { label: string; value: string; tone?: Tone; title?: string };

const num = (s?: string): number | undefined => {
  if (typeof s !== "string") return undefined;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
};
/** Format a derived number (percentage points) with an explicit sign. */
const pp = (v?: number, suffix = ""): string => (typeof v === "number" ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}${suffix}` : "—");
const plain = (v?: number, digits = 2): string => (typeof v === "number" ? v.toFixed(digits) : "—");
const str = (s?: string): string => (s && s.length > 0 ? s : "—");

function toneClass(tone: Tone): string {
  if (tone === "up") return "text-up";
  if (tone === "down") return "text-down";
  if (tone === "warn") return "text-[var(--warn,#b45309)]";
  return "text-fg";
}

function Section({ icon, title, tiles }: { icon: React.ReactNode; title: string; tiles: Tile[] }) {
  const shown = tiles.filter((t) => t.value !== "—");
  if (shown.length === 0) return null;
  return (
    <div className="rounded-xl border border-line p-4">
      <h3 className="mb-3 flex items-center gap-2 font-semibold text-fg">{icon} {title}</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {shown.map((t) => (
          <div key={t.label} className="rounded-lg border border-line/60 bg-surface/40 p-3" title={t.title}>
            <div className="text-faint text-[11px] uppercase tracking-wide">{t.label}</div>
            <div className={`tnum mt-1 text-base font-semibold ${toneClass(t.tone)}`}>{t.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Sparkline({ data, up }: { data: number[]; up: boolean }) {
  const w = 120;
  const h = 30;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * (w - 2) + 1;
      const y = h - 1 - ((v - min) / range) * (h - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <span className={up ? "text-up" : "text-down"}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" className="block">
        <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function TrendsSection({ history }: { history?: Record<string, number[]> }) {
  if (!history) return null;
  const defs = [
    { key: "tenY", label: "10Y yield", suffix: "%" },
    { key: "twoY", label: "2Y yield", suffix: "%" },
    { key: "vix", label: "VIX", suffix: "" },
    { key: "hyCreditSpread", label: "HY spread", suffix: "%" },
    { key: "usd", label: "USD index", suffix: "" },
    { key: "wti", label: "WTI oil", suffix: "" }
  ];
  const items = defs
    .map((d) => ({ ...d, data: history[d.key] }))
    .filter((d): d is typeof d & { data: number[] } => Array.isArray(d.data) && d.data.length >= 2);
  if (items.length === 0) return null;
  return (
    <div className="rounded-xl border border-line p-4">
      <h3 className="mb-3 flex items-center gap-2 font-semibold text-fg"><Activity size={16} className="text-[var(--accent)]" /> Trends (~90 days)</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {items.map((it) => {
          const last = it.data[it.data.length - 1];
          const first = it.data[0];
          const up = last >= first;
          const chg = first !== 0 ? ((last - first) / first) * 100 : 0;
          return (
            <div key={it.key} className="rounded-lg border border-line/60 bg-surface/40 p-3">
              <div className="flex items-baseline justify-between">
                <span className="text-faint text-[11px] uppercase tracking-wide">{it.label}</span>
                <span className="tnum text-xs text-fg">{last.toFixed(2)}{it.suffix}</span>
              </div>
              <div className="mt-2"><Sparkline data={it.data} up={up} /></div>
              <div className={`tnum mt-1 text-[11px] ${up ? "text-up" : "text-down"}`}>{up ? "+" : ""}{chg.toFixed(1)}% / 90d</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BreadthSection({ signals }: { signals: Board["signals"] }) {
  if (typeof signals.marketBreadthPct !== "number" && !signals.marketAdvancers) return null;
  const pct = signals.marketBreadthPct;
  const pctTone: Tone = typeof pct === "number" ? (pct >= 55 ? "up" : pct <= 45 ? "down" : undefined) : undefined;
  const Mover = ({ m }: { m: { sym: string; pct: number } }) => (
    <span className={`tnum ${m.pct >= 0 ? "text-up" : "text-down"}`}>{m.sym} {m.pct >= 0 ? "+" : ""}{m.pct.toFixed(1)}%</span>
  );
  return (
    <div className="rounded-xl border border-line p-4">
      <h3 className="mb-3 flex items-center gap-2 font-semibold text-fg"><Gauge size={16} className="text-info" /> Full-Market Breadth
        {signals.marketBreadthAsOf && <span className="text-faint text-xs font-normal">· {signals.marketBreadthAsOf}</span>}
      </h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <div className="rounded-lg border border-line/60 bg-surface/40 p-3" title="% of all ~12k US stocks advancing day-over-day (Massive grouped daily).">
          <div className="text-faint text-[11px] uppercase tracking-wide">Breadth (all US)</div>
          <div className={`tnum mt-1 text-base font-semibold ${toneClass(pctTone)}`}>{typeof pct === "number" ? `${pct}%` : "—"}</div>
        </div>
        <div className="rounded-lg border border-line/60 bg-surface/40 p-3">
          <div className="text-faint text-[11px] uppercase tracking-wide">Advancers</div>
          <div className="tnum mt-1 text-base font-semibold text-up">{signals.marketAdvancers?.toLocaleString() ?? "—"}</div>
        </div>
        <div className="rounded-lg border border-line/60 bg-surface/40 p-3">
          <div className="text-faint text-[11px] uppercase tracking-wide">Decliners</div>
          <div className="tnum mt-1 text-base font-semibold text-down">{signals.marketDecliners?.toLocaleString() ?? "—"}</div>
        </div>
      </div>
      {(signals.marketTopGainers?.length || signals.marketTopLosers?.length) ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 text-[13px]">
          {signals.marketTopGainers?.length ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-faint">Top gainers:</span>
              {signals.marketTopGainers.map((m) => <Mover key={m.sym} m={m} />)}
            </div>
          ) : null}
          {signals.marketTopLosers?.length ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-faint">Top losers:</span>
              {signals.marketTopLosers.map((m) => <Mover key={m.sym} m={m} />)}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function MacroBoardView({ snapshot }: { snapshot: DashboardSnapshot }) {
  const board = snapshot.macroBoard as Board | undefined;
  if (!board) {
    return <div className="rounded-xl border border-line p-6 text-sm text-faint">Macro data unavailable.</div>;
  }
  const { macro, derived, signals, regime } = board;
  const hySpread = num(macro.hyCreditSpread);

  const rates: Tile[] = [
    { label: "Fed funds", value: str(macro.fedFundsRate), title: "Federal funds effective rate (FRED FEDFUNDS)." },
    { label: "3M T-bill", value: str(macro.dgs3moTreasury) },
    { label: "2Y", value: str(macro.dgs2Treasury) },
    { label: "10Y", value: str(macro.dgs10Treasury) },
    { label: "Curve 3m10y", value: pp(derived.curve3m10y), tone: typeof derived.curve3m10y === "number" ? (derived.curve3m10y < 0 ? "down" : "up") : undefined, title: "10Y − 3M, pp. <0 = inverted (Fed's preferred recession curve)." },
    { label: "Curve 2s10s", value: pp(derived.curve2s10s), tone: typeof derived.curve2s10s === "number" ? (derived.curve2s10s < 0 ? "down" : "up") : undefined, title: "10Y − 2Y, pp. <0 = inverted." },
    { label: "10Y − Fed funds", value: pp(derived.yieldCurveSpread), tone: typeof derived.yieldCurveSpread === "number" ? (derived.yieldCurveSpread < 0 ? "down" : "up") : undefined }
  ];

  const inflationGrowth: Tile[] = [
    { label: "CPI (YoY)", value: str(macro.cpiInflation) },
    { label: "Core PCE", value: str(macro.corePCE), title: "The Fed's preferred inflation gauge (PCEPILFE YoY)." },
    { label: "10Y breakeven", value: str(macro.inflationExpectation10y), title: "Market-implied 10Y inflation expectation." },
    { label: "Real 10Y", value: pp(derived.real10Y), tone: typeof derived.real10Y === "number" ? (derived.real10Y > 2 ? "warn" : undefined) : undefined, title: "10Y − CPI, pp. The real risk-free rate; high pressures growth multiples." },
    { label: "Real Fed funds", value: pp(derived.realFedFunds), tone: typeof derived.realFedFunds === "number" ? (derived.realFedFunds > 1 ? "warn" : undefined) : undefined, title: "Fed funds − CPI. >0 = restrictive policy." },
    { label: "Real GDP", value: str(macro.realGDPGrowth), title: "Real GDP growth, annualized %." },
    { label: "Misery index", value: plain(derived.miseryIndex, 1), title: "Unemployment + inflation." }
  ];

  const risk: Tile[] = [
    { label: "VIX", value: str(macro.vix) },
    { label: "VIX 3M", value: str(macro.vix3m) },
    { label: "VIX term", value: plain(derived.vixTermStructure), tone: typeof derived.vixTermStructure === "number" ? (derived.vixTermStructure > 1 ? "down" : "up") : undefined, title: "VIX ÷ VIX3M. >1 = backwardation (acute near-term fear)." },
    { label: "SKEW", value: plain(signals.skew, 1), tone: typeof signals.skew === "number" ? (signals.skew > 140 ? "down" : undefined) : undefined, title: "Cboe SKEW — tail-risk / crash-hedging demand (>135–145 elevated)." },
    { label: "VVIX", value: plain(signals.vvix, 1), title: "Volatility of VIX itself." },
    { label: "HY credit spread", value: str(macro.hyCreditSpread), tone: typeof hySpread === "number" ? (hySpread > 5 ? "down" : hySpread < 3.5 ? "up" : undefined) : undefined, title: "ICE BofA US high-yield OAS — risk appetite; widening = risk-off." },
    { label: "Equity risk prem", value: pp(derived.equityRiskPremium), tone: typeof derived.equityRiskPremium === "number" ? (derived.equityRiskPremium < 0 ? "down" : derived.equityRiskPremium > 3 ? "up" : undefined) : undefined, title: "Market earnings yield − 10Y. Low/negative = stocks expensive vs bonds." },
    { label: "Consumer sent.", value: str(macro.consumerSentiment), title: "U. Michigan consumer sentiment." }
  ];

  const f = signals.factors1m;
  const positioning: Tile[] = [
    { label: "S&P spec net", value: typeof signals.cotSpNonCommNet === "number" ? signals.cotSpNonCommNet.toLocaleString() : "—", tone: typeof signals.cotSpNonCommNet === "number" ? (signals.cotSpNonCommNet >= 0 ? "up" : "down") : undefined, title: `CFTC large-speculator net E-mini S&P 500 contracts${signals.cotReportDate ? ` (as of ${signals.cotReportDate})` : ""}.` },
    { label: "Spec net %OI", value: typeof signals.cotSpNonCommNetPctOI === "number" ? `${signals.cotSpNonCommNetPctOI >= 0 ? "+" : ""}${signals.cotSpNonCommNetPctOI.toFixed(1)}%` : "—", tone: typeof signals.cotSpNonCommNetPctOI === "number" ? (signals.cotSpNonCommNetPctOI >= 0 ? "up" : "down") : undefined },
    { label: "Market (1m)", value: pp(f?.mktRf, "%"), tone: typeof f?.mktRf === "number" ? (f.mktRf >= 0 ? "up" : "down") : undefined, title: "Fama-French Mkt-RF, trailing ~1 month." },
    { label: "Size (1m)", value: pp(f?.smb, "%"), tone: typeof f?.smb === "number" ? (f.smb >= 0 ? "up" : "down") : undefined, title: "SMB (small minus big). + = small caps leading." },
    { label: "Value (1m)", value: pp(f?.hml, "%"), tone: typeof f?.hml === "number" ? (f.hml >= 0 ? "up" : "down") : undefined, title: "HML (value minus growth). + = value leading." },
    { label: "Momentum (1m)", value: pp(f?.mom, "%"), tone: typeof f?.mom === "number" ? (f.mom >= 0 ? "up" : "down") : undefined, title: "Momentum factor, trailing ~1 month." }
  ];

  const liquidity: Tile[] = [
    { label: "M2 growth", value: str(macro.m2GrowthYoY), title: "M2 money supply, YoY growth." },
    { label: "M2 supply", value: str(macro.m2MoneySupply) },
    { label: "USD index", value: str(macro.usdIndex), title: "Broad trade-weighted dollar; strong $ pressures multinationals/commodities." },
    { label: "WTI oil", value: str(macro.wtiOil) },
    { label: "Unemployment", value: str(macro.unemploymentRate) },
    { label: "Initial claims", value: str(macro.initialClaims), title: "Weekly initial jobless claims." },
    { label: "Housing starts", value: str(macro.housingStarts) }
  ];

  return (
    <div className="flex flex-col gap-4 text-sm text-fg">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-4">
        <div className="flex items-center gap-2 font-semibold text-fg"><Landmark size={16} className="text-[var(--accent)]" /> Macro &amp; Market Regime</div>
        <div className="flex items-center gap-2">
          <Chip tone="info">{regime}</Chip>
          {macro.asOf && <span className="text-faint text-xs">as of {macro.asOf}</span>}
        </div>
      </div>
      <p className="text-faint text-xs -mt-2">All values computed in the backend from free sources (FRED, Cboe, CFTC, Kenneth French) plus Massive (full-market breadth) — the same data fed to the agent. Factor returns lag ~6 weeks; CFTC is weekly.</p>
      <TrendsSection history={board.history} />
      <Section icon={<TrendingUp size={16} className="text-info" />} title="Rates & Yield Curve" tiles={rates} />
      <Section icon={<Activity size={16} className="text-info" />} title="Inflation & Growth" tiles={inflationGrowth} />
      <Section icon={<Gauge size={16} className="text-info" />} title="Risk & Volatility" tiles={risk} />
      <Section icon={<Gauge size={16} className="text-[var(--accent)]" />} title="Positioning & Factor Regime" tiles={positioning} />
      <BreadthSection signals={signals} />
      <Section icon={<Droplets size={16} className="text-info" />} title="Liquidity & Other" tiles={liquidity} />
    </div>
  );
}
