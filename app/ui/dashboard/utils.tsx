import {
    cellTitle,
    formatShareQuantity,
    quoteTitle,
    ratingTitle,
    sentimentTitle
} from "@/lib/dashboard-ui";
import { deriveMetrics } from "@/lib/derived-metrics";
import type {
    MarketQuote,
    MarketScan,
    StrategyTuningProposal,
    TradeProposal
} from "@/lib/types";
import type { ScanColumn, SortDir } from "../../dashboard-types";
import { compactMoney, compactNum, formatPct, money } from "../../dashboard-widgets";
import {
    Chip
} from "../../ui/primitives";
import { RatingChip, SentimentChip } from "./components";
import { DASH } from "./components";

export function resolveScanQuote(symbol: string, scan: MarketScan | null | undefined): MarketQuote | null {
  if (!scan) return null;
  const full = scan.topCandidates.find((q) => q.symbol === symbol);
  if (full) return full;
  const summary = scan.quotesBySymbol[symbol];
  if (!summary) return null;
  return { ...summary, volume: 0, intradayChangePct: 0, positionMarketValue: 0 };
}

export function scanSortValue(col: ScanColumn, q: MarketQuote): unknown {
  if (col.sortValue) return col.sortValue(q);
  return col.sortKey ? q[col.sortKey] : undefined;
}

function vwapDeltaPct(q: MarketQuote): number | undefined {
  if (typeof q.vwap !== "number" || !Number.isFinite(q.vwap) || q.vwap <= 0) return undefined;
  return ((q.price - q.vwap) / q.vwap) * 100;
}

function vwapTitle(q: MarketQuote): string | undefined {
  const delta = vwapDeltaPct(q);
  if (typeof delta !== "number") return undefined;
  return `Price ${money(q.price)} vs VWAP ${money(q.vwap)} (${formatPct(delta)}). ${cellTitle("VWAP", q.sources?.vwap)}`;
}

export function freshness(fetchedAt?: string): string {
  if (!fetchedAt) return "never";
  const mins = Math.round((Date.now() - new Date(fetchedAt).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

// ── Pending-proposal age + staleness ───────────────────────────────────────
// Proposals sit in the approval queue until a human acts on them, so an old one
// keeps looking "current" long after the scan and market conditions that produced
// it have moved on. We always show the exact proposal time, and escalate a
// staleness level so nobody approves a stale idea thinking the agent just made it.
export const PROPOSAL_STALE_AFTER_MS = 60 * 60 * 1000; // 1h → "Aging"
export const PROPOSAL_VERY_STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h → "Stale"

export type ProposalAge = {
  absolute: string;
  relative: string;
  staleness: "fresh" | "aging" | "stale";
};

function relativeAge(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return `${Math.floor(day / 7)}w ago`;
}

export function proposalAge(createdAt?: string, now: number = Date.now()): ProposalAge | null {
  if (!createdAt) return null;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return null;
  const ageMs = Math.max(0, now - t);
  const staleness =
    ageMs >= PROPOSAL_VERY_STALE_AFTER_MS ? "stale" : ageMs >= PROPOSAL_STALE_AFTER_MS ? "aging" : "fresh";
  return {
    absolute: new Date(t).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }),
    relative: relativeAge(ageMs),
    staleness
  };
}

export function marketStatusFor(session?: string): { tone: "up" | "warn" | "neutral"; label: string } {
  switch (session) {
    case "regular":
      return { tone: "up", label: "Market Open" };
    case "pre":
      return { tone: "warn", label: "Pre-market" };
    case "post":
      return { tone: "warn", label: "After-hours" };
    default:
      return { tone: "neutral", label: "Market Closed" };
  }
}

export function statusTone(status: string): "up" | "down" | "warn" | "accent" | "neutral" {
  if (status === "filled" || status === "placed" || status === "paper" || status === "approved" || status === "completed") return "up";
  if (status === "blocked" || status === "rejected" || status === "failed" || status === "expired" || status === "withdrawn") return "down";
  if (status === "pending_approval" || status === "pending" || status === "proposed") return "warn";
  return "neutral";
}

export function displayStatus(status: string): string {
  if (status === "paper") return "TEST";
  return status.toUpperCase();
}

export function proposalSize(proposal: TradeProposal, estimatedNotional?: number, price?: number): string {
  // Show the estimated total cost AND the share count. The "~" means it's an estimate
  // (fill price can differ). Shares use the app-wide formatter (up to 3 significant
  // figures, trailing zeros stripped — e.g. 0.5, 0.25, 1.5).
  const px = price && price > 0 ? price : proposal.limitPrice && proposal.limitPrice > 0 ? proposal.limitPrice : undefined;
  const cost = proposal.dollarAmount ?? estimatedNotional ?? (proposal.quantity && px ? proposal.quantity * px : undefined);
  const shares = proposal.quantity ?? (cost && px ? cost / px : undefined);
  if (typeof cost === "number" && cost > 0 && typeof shares === "number" && shares > 0) {
    return `~${money(cost)} for ${formatShareQuantity(shares, proposal.symbol)} shares`;
  }
  if (typeof cost === "number" && cost > 0) return `~${money(cost)}`;
  if (typeof shares === "number" && shares > 0) return `~${formatShareQuantity(shares, proposal.symbol)} shares`;
  return "—";
}

export function compare(left: unknown, right: unknown, dir: SortDir): number {
  const order = dir === "asc" ? 1 : -1;
  if (typeof left === "string" || typeof right === "string") return String(left ?? "").localeCompare(String(right ?? "")) * order;
  return (Number(left ?? 0) - Number(right ?? 0)) * order;
}

export function summarizeTuningPatch(proposal: StrategyTuningProposal): string[] {
  const patch = proposal.proposedPatch;
  const items: string[] = [];
  if (patch.prompt) items.push("Prompt rewrite proposed");
  for (const [key, value] of Object.entries(patch.scoringWeights ?? {})) items.push(`Weight ${labelize(key)} → ${formatPatchValue(value)}`);
  const policy = patch.policy ?? {};
  for (const [key, value] of Object.entries(policy)) {
    if (key === "riskRules" || value === undefined) continue;
    items.push(`${labelize(key)} → ${formatPatchValue(value)}`);
  }
  for (const [key, value] of Object.entries(policy.riskRules ?? {})) items.push(`${labelize(key)} → ${formatPatchValue(value)}`);
  return items;
}

export function formatPatchValue(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

export function labelize(value: string): string {
  return value
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function formatSectorCaps(caps: Record<string, number>): string {
  return Object.entries(caps).map(([sector, cap]) => `${sector}:${cap}`).join(", ");
}

export function parseSectorCaps(value: string): Record<string, number> {
  return Object.fromEntries(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [sector, cap] = item.split(":");
        return [sector?.trim() ?? "", Number(cap)] as const;
      })
      .filter(([sector, cap]) => sector.length > 0 && Number.isFinite(cap))
  );
}

export function normalizeSymbols(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim().toUpperCase()).filter((v) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(v))));
}

export function formatSources(sourceString: string): string {
  if (!sourceString) return "";
  return sourceString
    .split("+")
    .map((part) => {
      switch (part.trim().toLowerCase()) {
        case "nasdaq-delayed-screener":
          return "NASDAQ";
        case "finnhub":
          return "Finnhub";
        case "yahoo-finance":
          return "Yahoo";
        case "fmp":
          return "FMP";
        case "alpha-vantage":
          return "Alpha Vantage";
        case "massive-vwap":
          return "Massive VWAP";
        default:
          return part.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      }
    })
    .join(", ");
}

export function renderActionTitle(title: string) {
  const match = title.match(/^((?:Mock\/Local|Paper)\s+)?(buy|sell|bought|sold|buy:|sell:)\b(.*)$/i);
  if (!match) return <span className="font-semibold text-fg">{title}</span>;
  const [, paperPrefix = "", action, rest] = match;
  const cls = /sell|sold/i.test(action) ? "text-down" : "text-up";
  return (
    <span className="font-semibold text-fg">
      {paperPrefix}
      <span className={cls}>{action.toUpperCase()}</span>
      {rest}
    </span>
  );
}

export const SCAN_COLUMNS: ScanColumn[] = [
      { id: "symbol", label: "Symbol", title: "Ticker symbol. Hover a row for the company name.", sortKey: "symbol",
        render: (q) => <span className="font-semibold text-fg">{q.symbol}</span>, cellTitle: (q) => q.companyName },
      { id: "price", label: "Price", title: "Last traded price (delayed). Source: NASDAQ delayed screener, refined by Yahoo / broker quotes when available.", align: "right", sortKey: "price",
        render: (q) => <span className="tnum">{money(q.price)}</span>, cellTitle: (q) => quoteTitle("Quote", q) },
      { id: "intradayChangePct", label: "Chg", title: "Intraday price change, percent vs the prior session's close.", align: "right", sortKey: "intradayChangePct",
        render: (q) => <span className="tnum">{formatPct(q.intradayChangePct)}</span>, cellClass: (q) => (q.intradayChangePct >= 0 ? "text-up" : "text-down") },
      { id: "vsVwap", label: "vs VWAP", title: "Last price vs latest daily VWAP. Source: Massive grouped daily bars when available.", align: "right", sortValue: vwapDeltaPct,
        render: (q) => { const v = vwapDeltaPct(q); return typeof v === "number" ? <span className="tnum">{formatPct(v)}</span> : DASH; },
        cellClass: (q) => { const v = vwapDeltaPct(q); return typeof v === "number" ? (v >= 0 ? "text-up" : "text-down") : ""; },
        cellTitle: vwapTitle },
      { id: "volume", label: "Vol", title: "Shares traded today (falls back to the 10-day average when reported after hours). Source: screener / Finnhub.", align: "right", sortKey: "volume",
        render: (q) => (q.volume > 0 ? <span className="tnum text-muted">{compactNum(q.volume)}</span> : DASH) },
      { id: "marketCap", label: "Mkt Cap", title: "Market capitalization = share price × shares outstanding.", align: "right", sortKey: "marketCap",
        render: (q) => (q.marketCap && q.marketCap > 0 ? <span className="tnum text-muted">{compactMoney(q.marketCap)}</span> : DASH) },
      { id: "peRatio", label: "P/E", title: "Price-to-Earnings ratio = price ÷ trailing-12-month earnings per share; lower is cheaper relative to earnings. 'n/a' = negative/zero earnings (no meaningful ratio); '—' = no data. Source: Yahoo / FMP / Finnhub.", align: "right", sortKey: "peRatio",
        render: (q) => <span className="tnum text-muted">{q.peRatio && q.peRatio > 0 ? q.peRatio.toFixed(1) : typeof q.eps === "number" && q.eps <= 0 ? "n/a" : "—"}</span>, cellTitle: (q) => cellTitle("P/E ratio", q.sources?.peRatio) },
      { id: "fcfYield", label: "FCF%", title: "Free-cash-flow yield = trailing free cash flow ÷ market cap; higher means more cash generated per dollar of value. Source: Yahoo Finance.", align: "right", sortKey: "fcfYield",
        render: (q) => (typeof q.fcfYield === "number" ? <span className="tnum text-muted">{q.fcfYield.toFixed(1)}%</span> : DASH), cellTitle: (q) => cellTitle("Free-cash-flow yield", q.sources?.fcfYield) },
      { id: "debtToEquity", label: "D/E", title: "Debt-to-Equity = total debt ÷ shareholder equity; lower means less leverage. Source: Yahoo Finance.", align: "right", sortKey: "debtToEquity",
        render: (q) => (typeof q.debtToEquity === "number" ? <span className="tnum text-muted">{q.debtToEquity > 10 ? (q.debtToEquity / 100).toFixed(2) : q.debtToEquity.toFixed(2)}</span> : DASH), cellTitle: (q) => cellTitle("Debt / equity", q.sources?.debtToEquity) },
      { id: "epsGrowth", label: "EPS gr", title: "Earnings-per-share growth, year over year (e.g. +15%). Source: Yahoo Finance.", align: "right", sortKey: "epsGrowth",
        render: (q) => (typeof q.epsGrowth === "number" ? <span className="tnum">{(q.epsGrowth * 100).toFixed(0)}%</span> : DASH), cellClass: (q) => (typeof q.epsGrowth === "number" ? (q.epsGrowth >= 0 ? "text-up" : "text-down") : ""), cellTitle: (q) => cellTitle("EPS growth (YoY)", q.sources?.epsGrowth) },
      { id: "dividendYield", label: "Div", title: "Annual dividend yield = trailing dividends per share ÷ price. Source: Yahoo / Finnhub.", align: "right", sortKey: "dividendYield",
        render: (q) => (typeof q.dividendYield === "number" ? <span className="tnum text-muted">{q.dividendYield.toFixed(2)}%</span> : DASH) },
      // ── Backend-derived ratios (computed by us, not returned by any API). See src/lib/derived-metrics.ts. ──
      { id: "peg", label: "PEG", title: "[CALCULATED] PEG ratio = P/E ÷ EPS-growth%. <1 is cheap for its growth, >2 is expensive. Blank when unprofitable or no growth.", align: "right", sortValue: (q) => deriveMetrics(q).peg,
        render: (q) => { const v = deriveMetrics(q).peg; return typeof v === "number" ? <span className="tnum">{v.toFixed(2)}</span> : DASH; },
        cellClass: (q) => { const v = deriveMetrics(q).peg; return typeof v === "number" ? (v < 1 ? "text-up" : v > 2.5 ? "text-down" : "") : ""; } },
      { id: "roe", label: "ROE", title: "[CALCULATED] Return on equity = EPS ÷ book value per share, where BVPS = price ÷ P/B. Higher = more efficient use of capital; negative = losing money on equity.", align: "right", sortValue: (q) => deriveMetrics(q).roe,
        render: (q) => { const v = deriveMetrics(q).roe; return typeof v === "number" ? <span className="tnum">{v.toFixed(1)}%</span> : DASH; },
        cellClass: (q) => { const v = deriveMetrics(q).roe; return typeof v === "number" ? (v >= 0 ? "text-up" : "text-down") : ""; } },
      { id: "earnYld", label: "Earn Yld", title: "[CALCULATED] Earnings yield = EPS ÷ price (the inverse of P/E). Usable when P/E is n/a; negative = the company is losing money.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).earnYld,
        render: (q) => { const v = deriveMetrics(q).earnYld; return typeof v === "number" ? <span className="tnum text-muted">{v.toFixed(2)}%</span> : DASH; },
        cellClass: (q) => { const v = deriveMetrics(q).earnYld; return typeof v === "number" ? (v >= 0 ? "text-up" : "text-down") : ""; } },
      { id: "payout", label: "Payout", title: "[CALCULATED] Dividend payout ratio = dividends per share ÷ EPS. >100% means the dividend exceeds earnings and may be unsustainable.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).payout,
        render: (q) => { const v = deriveMetrics(q).payout; return typeof v === "number" ? <span className="tnum text-muted">{v.toFixed(0)}%</span> : DASH; },
        cellClass: (q) => { const v = deriveMetrics(q).payout; return typeof v === "number" && v > 100 ? "text-down" : ""; } },
      { id: "dollarVolM", label: "$ Vol", title: "[CALCULATED] Daily dollar volume = price × volume — liquidity gauge for position sizing and slippage.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).dollarVolM,
        render: (q) => { const v = deriveMetrics(q).dollarVolM; return typeof v === "number" ? <span className="tnum text-muted">{compactMoney(v * 1e6)}</span> : DASH; } },
      { id: "spreadBps", label: "Spread", title: "[CALCULATED] Bid-ask spread in basis points = (ask − bid) ÷ mid × 10000 — execution cost; wide spreads favor limit orders.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).spreadBps,
        render: (q) => { const v = deriveMetrics(q).spreadBps; return typeof v === "number" ? <span className="tnum text-muted">{v.toFixed(1)}</span> : DASH; } },
      { id: "sectorRelStrength", label: "Sec RS", title: "[CALCULATED] Sector relative strength = this name's intraday % move minus the average move of its sector among the scan candidates. Positive = outperforming its sector today.", align: "right", defaultHidden: true, sortKey: "sectorRelStrength",
        render: (q) => (typeof q.sectorRelStrength === "number" ? <span className="tnum">{q.sectorRelStrength >= 0 ? "+" : ""}{q.sectorRelStrength.toFixed(2)}%</span> : DASH),
        cellClass: (q) => (typeof q.sectorRelStrength === "number" ? (q.sectorRelStrength >= 0 ? "text-up" : "text-down") : "") },
      { id: "marginOfSafety", label: "MoS", title: "[CALCULATED] Margin of safety = (Graham value − price) ÷ price, where Graham value = √(22.5 × EPS × book value per share). Positive = trading below intrinsic value.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).marginOfSafety,
        render: (q) => { const v = deriveMetrics(q).marginOfSafety; return typeof v === "number" ? <span className="tnum">{v >= 0 ? "+" : ""}{v.toFixed(0)}%</span> : DASH; },
        cellClass: (q) => { const v = deriveMetrics(q).marginOfSafety; return typeof v === "number" ? (v >= 0 ? "text-up" : "text-down") : ""; } },
      { id: "pctFromHigh", label: "% off Hi", title: "[CALCULATED] % from the 52-week high = (price − 52w high) ÷ high. 0 = at the high (breakout zone); deeply negative = a large pullback.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).pctFromHigh,
        render: (q) => { const v = deriveMetrics(q).pctFromHigh; return typeof v === "number" ? <span className="tnum text-muted">{v.toFixed(1)}%</span> : DASH; } },
      { id: "rr52w", label: "R:R", title: "[CALCULATED] Reward:risk to the 52-week band = (52w high − price) ÷ (price − 52w low). >1 = more upside room to the high than downside to the low.", align: "right", defaultHidden: true, sortValue: (q) => deriveMetrics(q).rr52w,
        render: (q) => { const v = deriveMetrics(q).rr52w; return typeof v === "number" ? <span className="tnum text-muted">{v.toFixed(2)}</span> : DASH; } },
      { id: "shortPercentOfFloat", label: "Short %", title: "Percent of the tradable float sold short. High (>15–20%) raises short-squeeze potential but also signals bearish positioning. Source: Yahoo Finance.", align: "right", defaultHidden: true, sortKey: "shortPercentOfFloat",
        render: (q) => (typeof q.shortPercentOfFloat === "number" ? <span className="tnum text-muted">{q.shortPercentOfFloat.toFixed(1)}%</span> : DASH) },
      { id: "beta", label: "Beta", title: "Beta — sensitivity to the broad market (1.0 = moves with the market; >1 amplifies moves, <1 dampens them). Source: Yahoo Finance.", align: "right", defaultHidden: true, sortKey: "beta",
        render: (q) => (typeof q.beta === "number" ? <span className="tnum text-muted">{q.beta.toFixed(2)}</span> : DASH) },
      { id: "bid", label: "Bid", title: "Best bid — the highest price a buyer is currently willing to pay. Shown when broker quotes are available.", align: "right", defaultHidden: true, sortKey: "bid",
        render: (q) => (typeof q.bid === "number" ? <span className="tnum text-muted">{money(q.bid)}</span> : DASH) },
      { id: "ask", label: "Ask", title: "Best ask — the lowest price a seller is currently willing to accept. Shown when broker quotes are available.", align: "right", defaultHidden: true, sortKey: "ask",
        render: (q) => (typeof q.ask === "number" ? <span className="tnum text-muted">{money(q.ask)}</span> : DASH) },
      { id: "sentiment", label: "Sentiment", title: "News sentiment 0–100 (50 = neutral), scored from recent headlines with keyword/NLP analysis. Source: Alpha Vantage / Finnhub.", sortKey: "sentiment",
        render: (q) => (typeof q.sentiment === "number" ? <SentimentChip value={q.sentiment} /> : DASH), cellTitle: (q) => sentimentTitle(q) },
      { id: "analystScore", label: "Rating", title: "Analyst consensus 0–100, blended across providers (Strong Buy = 100 … Strong Sell = 0). Source: Yahoo / FMP / Finnhub.", sortKey: "analystScore",
        render: (q) => (q.analystRating ? <RatingChip score={q.analystScore} label={q.analystRating} /> : DASH), cellTitle: (q) => ratingTitle(q) },
      { id: "senateTrades", label: "Congress", title: "Net recent congressional trades = distinct members buying minus selling over the last ~60 days; positive = net buying (a positioning tailwind). Source: U.S. Senate eFD + Capitol Trades. Hover a cell for the disclosures.", align: "right", sortKey: "senateTrades",
        render: (q) => (typeof q.senateTrades === "number" ? <span className="tnum">{q.senateTrades > 0 ? `+${q.senateTrades}` : q.senateTrades}</span> : DASH), cellClass: (q) => (typeof q.senateTrades === "number" && q.senateTrades !== 0 ? (q.senateTrades > 0 ? "text-up" : "text-down") : ""), cellTitle: (q) => q.evidenceBulletins?.join("\n") || "No recent congressional disclosures for this symbol." },
      { id: "sector", label: "Sector", title: "Company sector classification. Source: Yahoo / Finnhub.", sortKey: "sector",
        render: (q) => (q.sector ? <Chip tone="info">{q.sector}</Chip> : DASH) },
      { id: "score", label: "Score", title: "Composite 0–100 score = weighted blend of liquidity, momentum, value, quality, volatility, sentiment & diversification factors. Adjust the weights on the Strategy tab.", align: "right", sortKey: "score",
        render: (q) => <span className="tnum font-semibold text-fg">{q.score.toFixed(1)}</span> }
    ];
export const DEFAULT_SCAN_COLS = SCAN_COLUMNS.filter((c) => !c.defaultHidden).map((c) => c.id);
export const SCAN_COLS_KEY = "scan-visible-cols";
