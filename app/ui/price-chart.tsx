"use client";

import { useEffect, useRef, useState } from "react";
import type { IChartApi } from "lightweight-charts";
import { cn } from "./cn";

const timeframes = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "All"] as const;
type Timeframe = typeof timeframes[number];

interface ChartBar {
  time: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Resolve a theme CSS variable to a concrete color for the canvas (with a fallback). */
function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Rolling simple moving average aligned to bar times; entries before `period` are dropped. */
function smaLine(bars: ChartBar[], period: number): Array<{ time: string; value: number }> {
  if (bars.length < period) return [];
  const out: Array<{ time: string; value: number }> = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    if (i >= period - 1) out.push({ time: bars[i].time, value: sum / period });
  }
  return out;
}

/**
 * Daily price chart for the symbol drilldown — TradingView Lightweight Charts (MIT, v5),
 * fed our own free OHLC via /api/history. The library is dynamically imported so it loads
 * only when the drawer opens (kept out of the main bundle). Themed from the app's CSS
 * variables so it follows the dark/light terminal theme.
 */
export function PriceChart({ symbol }: { symbol: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const barsRef = useRef<ChartBar[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [meta, setMeta] = useState<{ change?: number; label?: string } | null>(null);
  const [activeTimeframe, setActiveTimeframe] = useState<Timeframe>("1Y");

  const updateTimeframe = (tf: Timeframe, chartToUse?: IChartApi, barsToUse?: ChartBar[]) => {
    setActiveTimeframe(tf);
    const chart = chartToUse || chartRef.current;
    const bars = barsToUse || barsRef.current;
    if (!chart || bars.length === 0) return;

    const lastBar = bars[bars.length - 1];
    const lastDate = new Date(lastBar.time + "T00:00:00Z");
    let fromDate = new Date(lastDate);

    if (tf === "1D") {
      // For daily bars, 1D is just the last day (or we can go back 1 day to show 2 bars)
      fromDate.setDate(fromDate.getDate() - 1);
    } else if (tf === "5D") {
      fromDate.setDate(fromDate.getDate() - 6); // roughly 5 trading days
    } else if (tf === "1M") {
      fromDate.setMonth(fromDate.getMonth() - 1);
    } else if (tf === "6M") {
      fromDate.setMonth(fromDate.getMonth() - 6);
    } else if (tf === "YTD") {
      fromDate = new Date(lastDate.getUTCFullYear(), 0, 1);
    } else if (tf === "1Y") {
      fromDate.setFullYear(fromDate.getUTCFullYear() - 1);
    } else if (tf === "5Y") {
      fromDate.setFullYear(fromDate.getUTCFullYear() - 5);
    }

    const fromStr = tf === "All" ? bars[0].time : fromDate.toISOString().slice(0, 10);

    if (tf === "All") {
      chart.timeScale().fitContent();
    } else {
      chart.timeScale().setVisibleRange({
        from: fromStr,
        to: lastBar.time
      });
    }

    const visibleBars = bars.filter(b => b.time >= fromStr);
    if (visibleBars.length > 0) {
      const first = visibleBars[0].close;
      const last = visibleBars[visibleBars.length - 1].close;
      setMeta({ change: first > 0 ? ((last - first) / first) * 100 : undefined, label: tf });
    } else {
      // Fallback if no bars exist in the range (e.g. IPO happened recently)
      chart.timeScale().fitContent();
      const first = bars[0].close;
      const last = bars[bars.length - 1].close;
      setMeta({ change: first > 0 ? ((last - first) / first) * 100 : undefined, label: "All" });
    }
  };

  useEffect(() => {
    let disposed = false;
    let chart: IChartApi | null = null;
    setState("loading");
    setMeta(null);

    (async () => {
      try {
        const res = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}`);
        const json: { bars?: ChartBar[] } = await res.json();
        const bars = (json.bars ?? []).filter((b) => Number.isFinite(b.close));
        if (disposed) return;
        if (bars.length < 2 || !containerRef.current) {
          setState("empty");
          return;
        }

        const lc = await import("lightweight-charts");
        if (disposed || !containerRef.current) return;

        const up = cssVar("--up", "#10b981");
        const down = cssVar("--down", "#ef4444");
        const text = cssVar("--faint", "#94a3b8");
        const grid = cssVar("--line", "#1f2937");
        const accent = cssVar("--accent", "#3b82f6");
        const info = cssVar("--info", "#06b6d4");

        const c = lc.createChart(containerRef.current, {
          autoSize: true,
          layout: { background: { type: lc.ColorType.Solid, color: "transparent" }, textColor: text, fontSize: 11, attributionLogo: false },
          grid: { vertLines: { color: grid }, horzLines: { color: grid } },
          rightPriceScale: { borderColor: grid },
          timeScale: { borderColor: grid, fixLeftEdge: true, fixRightEdge: true },
          crosshair: { mode: lc.CrosshairMode.Normal },
          handleScale: { axisPressedMouseMove: false },
        });
        chart = c;
        chartRef.current = c;
        barsRef.current = bars;

        const candle = c.addSeries(lc.CandlestickSeries, {
          upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
        });
        candle.setData(bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));

        const sma50 = smaLine(bars, 50);
        if (sma50.length > 0) {
          c.addSeries(lc.LineSeries, { color: accent, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData(sma50);
        }
        const sma200 = smaLine(bars, 200);
        if (sma200.length > 0) {
          c.addSeries(lc.LineSeries, { color: info, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData(sma200);
        }

        // Volume as a thin histogram pinned to the bottom of the pane.
        const vol = c.addSeries(lc.HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol" });
        c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
        vol.setData(
          bars
            .filter((b) => typeof b.volume === "number")
            .map((b) => ({ time: b.time, value: b.volume as number, color: b.close >= b.open ? up : down }))
        );

        updateTimeframe(activeTimeframe, c, bars);
        setState("ready");
      } catch {
        if (!disposed) setState("error");
      }
    })();

    return () => {
      disposed = true;
      if (chart) {
        try {
          chart.remove();
        } catch {
          /* already disposed */
        }
      }
    };
  }, [symbol]);

  return (
    <div className="rounded-xl border border-line p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-semibold text-fg">
          <span className="text-[var(--accent)]">◴</span> Price
        </h3>
        <div className="flex items-center gap-1">
          {timeframes.map((tf) => (
            <button
              key={tf}
              onClick={() => updateTimeframe(tf)}
              className={cn(
                "px-2 py-0.5 text-[11px] font-medium rounded transition-colors",
                activeTimeframe === tf ? "bg-[var(--accent)] text-white" : "text-faint hover:text-fg hover:bg-surface-2"
              )}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>
      <div className="mb-3 flex items-center gap-3 text-[11px] text-faint">
        <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-3 bg-[var(--accent)]" /> SMA50</span>
        <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-3 bg-info" /> SMA200</span>
        {meta?.change !== undefined && (
          <span className={meta.change >= 0 ? "text-up" : "text-down"}>
            {meta.change >= 0 ? "+" : ""}{meta.change.toFixed(1)}% {meta.label}
          </span>
        )}
      </div>
      <div className="relative h-[300px] w-full">
        <div ref={containerRef} className="h-full w-full" />
        {state !== "ready" && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-faint">
            {state === "loading" && "Loading price history…"}
            {state === "empty" && "No price history available for this symbol."}
            {state === "error" && "Couldn't load price history."}
          </div>
        )}
      </div>
    </div>
  );
}
