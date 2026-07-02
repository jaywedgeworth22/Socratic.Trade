"use client";

/** Reusable symbol drilldown for the console: a clickable ticker
 *  (<SymbolButton>) that opens a Sheet with the company logo, a daily price
 *  chart over /api/history, the current price/change when the snapshot's last
 *  market scan knows the symbol, and a few key stats. Everything degrades
 *  honestly: no history → a sentence, no quote → "—", never a crash. */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { MarketQuoteSummary } from "@/lib/types";
import { useConsoleData } from "../lib/useConsoleData";
import { cx, fmtMoney, fmtNum, fmtPct, fmtQty, EM_DASH } from "../lib/format";
import { Dash } from "./primitives";
import { Sheet } from "./sheet";
import { TickerLogo } from "./ticker-logo";

// ── Data ─────────────────────────────────────────────────────────────────────

interface HistoryBar {
  time: string; // YYYY-MM-DD
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
}

type HistoryState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error" }
  | { status: "ready"; bars: HistoryBar[] };

function useHistory(symbol: string, enabled: boolean): HistoryState {
  const [state, setState] = useState<HistoryState>({ status: "loading" });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      try {
        const res = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}`);
        if (!res.ok) throw new Error(`history ${res.status}`);
        const json: { bars?: HistoryBar[] } = await res.json();
        const bars = (json.bars ?? []).filter((b) => typeof b.close === "number" && Number.isFinite(b.close));
        if (cancelled) return;
        setState(bars.length >= 2 ? { status: "ready", bars } : { status: "empty" });
      } catch {
        if (!cancelled) setState({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol, enabled]);

  return state;
}

/** Best-available quote summary for a symbol from the snapshot's last scan. */
function resolveQuote(
  quotesBySymbol: Record<string, MarketQuoteSummary> | undefined,
  symbol: string
): MarketQuoteSummary | null {
  if (!quotesBySymbol) return null;
  const normalized = symbol.trim().toUpperCase();
  return (
    quotesBySymbol[normalized] ??
    Object.values(quotesBySymbol).find((q) => q.symbol?.trim().toUpperCase() === normalized) ??
    null
  );
}

// ── Chart ────────────────────────────────────────────────────────────────────

const TIMEFRAMES = ["1M", "6M", "1Y", "All"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

function cutoffFor(tf: Timeframe, lastDay: string): string | null {
  if (tf === "All") return null;
  const d = new Date(`${lastDay}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return null;
  if (tf === "1M") d.setUTCMonth(d.getUTCMonth() - 1);
  else if (tf === "6M") d.setUTCMonth(d.getUTCMonth() - 6);
  else d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

const W = 640;
const H = 180;
const PAD = 6;

/** Self-contained SVG close-price line (same honest style as EquityChart):
 *  no interpolation, fewer than two visible points renders a sentence. */
function PriceHistoryChart({ bars }: { bars: HistoryBar[] }) {
  const [tf, setTf] = useState<Timeframe>("1Y");

  const visible = useMemo(() => {
    const cutoff = cutoffFor(tf, bars[bars.length - 1].time);
    const inRange = cutoff ? bars.filter((b) => b.time >= cutoff) : bars;
    // A recent IPO may have no bars inside the window — fall back to everything.
    return inRange.length >= 2 ? inRange : bars;
  }, [bars, tf]);

  const vMin = Math.min(...visible.map((b) => b.close));
  const vMax = Math.max(...visible.map((b) => b.close));
  const vSpan = vMax - vMin || 1;
  const x = (i: number) => PAD + (i / (visible.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - vMin) / vSpan) * (H - PAD * 2);
  const path = visible.map((b, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(b.close).toFixed(1)}`).join(" ");
  const first = visible[0].close;
  const last = visible[visible.length - 1].close;
  const changePct = first > 0 ? ((last - first) / first) * 100 : undefined;
  const rising = last >= first;
  const stroke = rising ? "var(--con-pos)" : "var(--con-neg)";

  return (
    <figure>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="con-num text-[length:var(--con-fs-xs)]" style={{ color: stroke }}>
          {changePct !== undefined ? `${fmtPct(changePct, 1, true)} over ${tf === "All" ? "all history" : tf}` : EM_DASH}
        </span>
        <div className="flex items-center gap-1">
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTf(t)}
              title={t === "All" ? "Show all available daily history" : `Show the last ${t === "1M" ? "month" : t === "6M" ? "6 months" : "year"}`}
              className={cx(
                "rounded px-2 py-0.5 text-[length:var(--con-fs-xs)] font-semibold transition-colors",
                t === tf
                  ? "bg-[color:var(--con-accent-soft)] text-[color:var(--con-accent)]"
                  : "text-[color:var(--con-faint)] hover:text-[color:var(--con-fg)]"
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)]"
        role="img"
        aria-label={`Daily closes from ${fmtMoney(first)} to ${fmtMoney(last)}`}
      >
        <path d={path} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <figcaption className="con-num mt-1 flex justify-between text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        <span>
          {visible[0].time} · {fmtMoney(first)}
        </span>
        <span>
          low {fmtMoney(vMin)} · high {fmtMoney(vMax)}
        </span>
        <span>
          {visible[visible.length - 1].time} · {fmtMoney(last)}
        </span>
      </figcaption>
    </figure>
  );
}

// ── Drilldown sheet ──────────────────────────────────────────────────────────

function StatCell({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="cursor-default" title={title}>
      <div className="con-card-title mb-0.5">{label}</div>
      <div className="con-num text-[length:var(--con-fs-sm)]">{children}</div>
    </div>
  );
}

export function SymbolDrilldownSheet({
  symbol,
  open,
  onClose
}: {
  symbol: string;
  open: boolean;
  onClose: () => void;
}) {
  const { snapshot } = useConsoleData();
  const normalized = symbol.trim().toUpperCase();
  const history = useHistory(normalized, open);

  const quote = resolveQuote(snapshot?.latestStrategyRun?.marketScan?.quotesBySymbol, normalized);
  const meta = snapshot?.symbolMetaBySymbol?.[normalized];
  const position = snapshot?.positions?.find((p) => p.symbol.trim().toUpperCase() === normalized);
  const companyName = quote?.companyName ?? meta?.companyName;

  // Current price: prefer the scan quote; otherwise the last daily close.
  const lastBars = history.status === "ready" ? history.bars : [];
  const lastClose = lastBars.length > 0 ? lastBars[lastBars.length - 1].close : undefined;
  const prevClose = lastBars.length > 1 ? lastBars[lastBars.length - 2].close : undefined;
  const price = typeof quote?.price === "number" && quote.price > 0 ? quote.price : lastClose;
  const dayChangePct =
    typeof lastClose === "number" && typeof prevClose === "number" && prevClose > 0
      ? ((lastClose - prevClose) / prevClose) * 100
      : undefined;

  const title = (
    <span className="flex min-w-0 items-center gap-2.5">
      <TickerLogo symbol={normalized} size="md" />
      <span className="min-w-0">
        <span className="block leading-tight">{normalized}</span>
        {companyName && (
          <span className="block truncate text-[length:var(--con-fs-xs)] font-normal text-[color:var(--con-faint)]">
            {companyName}
          </span>
        )}
      </span>
    </span>
  );

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="flex flex-col gap-4">
        {/* Price line */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="con-num text-[length:var(--con-fs-xl)] font-semibold leading-tight">{fmtMoney(price)}</span>
          {typeof dayChangePct === "number" && (
            <span
              className="con-num text-[length:var(--con-fs-sm)] font-semibold"
              style={{ color: dayChangePct >= 0 ? "var(--con-pos)" : "var(--con-neg)" }}
              title="Last daily close vs the previous close"
            >
              {fmtPct(dayChangePct, 2, true)} last close
            </span>
          )}
          {quote?.sector && (
            <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              {quote.sector}
              {quote.industry && quote.industry !== quote.sector ? ` · ${quote.industry}` : ""}
            </span>
          )}
        </div>

        {/* Chart */}
        {history.status === "loading" && (
          <p className="py-8 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
            Loading price history…
          </p>
        )}
        {history.status === "empty" && (
          <p className="py-8 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
            No price history is available for {normalized} yet.
          </p>
        )}
        {history.status === "error" && (
          <p className="py-8 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
            Couldn&apos;t load price history for {normalized}.
          </p>
        )}
        {history.status === "ready" && <PriceHistoryChart bars={history.bars} />}

        {/* Key stats — only what the snapshot honestly knows */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCell label="P/E" title="Price divided by trailing earnings per share, from the last market scan. — means the data wasn't available.">
            {typeof quote?.peRatio === "number" ? fmtNum(quote.peRatio) : <Dash />}
          </StatCell>
          <StatCell label="52w range" title="The lowest and highest daily price over the past 52 weeks.">
            {typeof quote?.fiftyTwoWeekLow === "number" && typeof quote?.fiftyTwoWeekHigh === "number" ? (
              `${fmtMoney(quote.fiftyTwoWeekLow)}–${fmtMoney(quote.fiftyTwoWeekHigh)}`
            ) : (
              <Dash />
            )}
          </StatCell>
          <StatCell label="Scan score" title="Composite 0–100 score from the last market scan — how attractive the screener ranked this symbol.">
            {typeof quote?.score === "number" ? fmtNum(quote.score) : <Dash />}
          </StatCell>
          <StatCell label="Your position" title="What the selected account currently holds in this symbol.">
            {position ? `${fmtQty(position.quantity)} sh · ${fmtMoney(position.marketValue)}` : "none"}
          </StatCell>
        </div>

        {quote?.asOf && (
          <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            Quote data from the last market scan ({new Date(quote.asOf).toLocaleString()}).
          </p>
        )}
      </div>
    </Sheet>
  );
}

// ── SymbolButton ─────────────────────────────────────────────────────────────

/** A ticker rendered as logo + text that opens the drilldown sheet. Drop this
 *  wherever a table shows a symbol. Owns its own sheet state. */
export function SymbolButton({
  symbol,
  className,
  title,
  showLogo = true,
  logoSize = "sm",
  children
}: {
  symbol: string;
  className?: string;
  title?: string;
  showLogo?: boolean;
  logoSize?: "sm" | "md" | "lg";
  /** Optional custom label; defaults to the symbol text. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const normalized = symbol.trim().toUpperCase();

  return (
    <>
      <button
        type="button"
        title={title ?? `Open ${normalized} details`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={cx(
          "inline-flex cursor-pointer items-center gap-1.5 font-semibold underline decoration-[color:var(--con-line-strong)] decoration-1 underline-offset-[3px] transition-colors hover:text-[color:var(--con-accent)] hover:decoration-[color:var(--con-accent)]",
          className
        )}
      >
        {showLogo && <TickerLogo symbol={normalized} size={logoSize} />}
        <span>{children ?? normalized}</span>
      </button>
      {open && <SymbolDrilldownSheet symbol={normalized} open={open} onClose={() => setOpen(false)} />}
    </>
  );
}
