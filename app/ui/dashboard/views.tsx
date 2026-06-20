import {
    companyTitle,
    formatNotificationDisplay,
    formatShareQuantity,
    receivedLabel
} from "@/lib/dashboard-ui";
import type {
    MarketQuote,
    MarketScan,
    StrategyTuningProposal,
    TradingPolicy
} from "@/lib/types";
import {
    Activity as ActivityIcon,
    BrainCircuit,
    Check,
    CheckCircle,
    Gauge,
    Hourglass,
    Landmark,
    LineChartIcon,
    Percent,
    RefreshCw,
    Settings as SettingsIcon,
    Shield,
    Sparkles,
    TrendingUp,
    XCircle,
    Zap
} from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { TableVirtuoso } from "react-virtuoso";
import type { DashboardSnapshot, PolicyPatch, SortDir } from "../../dashboard-types";
import { money, signedMoney } from "../../dashboard-widgets";
import { cn } from "../../ui/cn";
import {
    Button,
    Card,
    Chip,
    EmptyState,
    Field,
    IconButton,
    PanelHeader,
    StatTile,
    inputClass
} from "../../ui/primitives";
import { EditableParam, EquityCurve, NumberField, ScorecardBars, SymbolButton } from "./components";
import { TuningCard } from "./settings";
import { DEFAULT_SCAN_COLS, SCAN_COLS_KEY, SCAN_COLUMNS, compare, displayStatus, formatSectorCaps, formatSources, freshness, parseSectorCaps, proposalSize, renderActionTitle, scanSortValue, statusTone } from "./utils";

export function DecisionView({
  snapshot,
  symbolMetaBySymbol,
  busy,
  approve,
  reject,
  scan,
  onDrilldown
}: {
  snapshot: DashboardSnapshot;
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
  busy: boolean;
  approve: (id: string) => void;
  reject: (id: string) => void;
  scan: MarketScan | null;
  onDrilldown: (q: MarketQuote) => void;
}) {
  const decision = snapshot.latestStrategyRun;
  const pending = snapshot.pendingProposals;
  return (
    <div className="space-y-3">
      {pending.length > 0 && (
        <Card className="overflow-hidden">
          <PanelHeader title="Pending approval" subtitle="Review and approve or reject" icon={<CheckCircle size={16} />} />
          <div className="grid gap-2 p-4 pt-3 sm:grid-cols-2">
            {pending.map((p) => (
              <div key={p.id} className="rounded-xl border border-line bg-surface-2/50 backdrop-blur-lg p-3">
                <div className="flex items-center gap-2">
                  <Chip tone={p.proposal.side === "buy" ? "up" : "down"}>{p.proposal.side.toUpperCase()}</Chip>
                  <SymbolButton symbol={p.proposal.symbol} scan={scan} onDrilldown={onDrilldown} className="text-base font-semibold text-fg" title={companyTitle(p.proposal.symbol, symbolMetaBySymbol)} />
                  <span className="ml-auto tnum text-xs text-muted" title="Estimated total cost and share count. The '~' means it's an estimate — the actual fill price (and so the exact shares) can differ slightly.">{proposalSize(p.proposal, p.review?.estimatedNotional, decision?.marketScan?.quotesBySymbol[p.proposal.symbol]?.price)}</span>
                </div>
                <p className="mt-2 line-clamp-3 text-[13px] leading-snug text-muted" title={p.proposal.rationale}>{p.proposal.rationale}</p>
                <div className="mt-3 flex gap-2">
                  <Button variant="primary" size="sm" className="flex-1" disabled={busy} onClick={() => approve(p.id)}>
                    <Check size={14} /> Approve
                  </Button>
                  <Button variant="ghost" size="sm" className="flex-1" disabled={busy} onClick={() => reject(p.id)}>
                    <XCircle size={14} /> Reject
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="overflow-hidden">
        <PanelHeader
          title="Latest decisions"
          subtitle={decision?.marketScan ? `${decision.marketScan.scannedSymbols} symbols scanned · ${formatSources(decision.marketScan.source)}` : "Run the strategy to generate a decision"}
          icon={<Sparkles size={16} />}
        />
        {!decision ? (
          <EmptyState icon={<BrainCircuit size={20} />} title="No decision yet" hint="Hit Run (or open the command palette → Run strategy once) to generate the agent's first decision." />
        ) : (
          <div className="space-y-3 p-4 pt-3">
            <div className={cn("rounded-xl border px-3 py-2 text-[13px]", decision.status === "failed" ? "border-down/30 bg-down/10 text-down" : "border-info/25 bg-info/10 text-fg")}>
              {decision.summary}
            </div>
            {decision.proposals.map((item, i) => (
              <div key={`${item.proposal.symbol}-${i}`} className="rounded-xl border border-line bg-surface-2/50 backdrop-blur-lg p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={statusTone(item.status)}>{displayStatus(item.status)}</Chip>
                  <Chip tone={item.proposal.side === "buy" ? "up" : "down"}>{item.proposal.side.toUpperCase()}</Chip>
                  <SymbolButton symbol={item.proposal.symbol} scan={scan} onDrilldown={onDrilldown} className="font-semibold text-fg" title={companyTitle(item.proposal.symbol, symbolMetaBySymbol)} />
                  <span className="tnum text-xs text-muted" title="Estimated total cost and share count. The '~' means it's an estimate — the actual fill price (and so the exact shares) can differ slightly.">{proposalSize(item.proposal, undefined, decision?.marketScan?.quotesBySymbol[item.proposal.symbol]?.price)} · {item.proposal.type}</span>
                  {item.proposal.tradeThesisTag && <Chip tone="accent">{item.proposal.tradeThesisTag}</Chip>}
                </div>
                <p className="mt-2 text-[13px] leading-snug text-muted">{item.proposal.rationale}</p>
                {item.reasons.length > 0 && <p className="mt-1.5 rounded bg-surface-3/50 backdrop-blur-md px-2 py-1 text-[11px] text-faint">{item.reasons.join("; ")}</p>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export function MarketScanView({ snapshot, onDrilldown }: { snapshot: DashboardSnapshot, onDrilldown: (q: MarketQuote) => void }) {
  const [sort, setSort] = useState<{ col: string; dir: SortDir }>({ col: "score", dir: "desc" });
  const [visible, setVisible] = useState<string[]>(DEFAULT_SCAN_COLS);
  const [colsOpen, setColsOpen] = useState(false);
  const [liveScan, setLiveScan] = useState<MarketScan | null>(null);
  const [scanLoading, setScanLoading] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(SCAN_COLS_KEY);
      if (saved) {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr) && arr.length > 0) setVisible(arr.filter((id) => SCAN_COLUMNS.some((c) => c.id === id)));
      }
    } catch {
      /* ignore */
    }
  }, []);

  function toggleCol(id: string) {
    if (id === "symbol") return; // symbol is always shown
    const next = visible.includes(id) ? visible.filter((c) => c !== id) : [...visible, id];
    setVisible(next);
    try {
      localStorage.setItem(SCAN_COLS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }

  const refreshScan = useCallback(async () => {
    setScanLoading(true);
    try {
      const res = await fetch("/api/scan");
      if (res.ok) {
        const data = (await res.json()) as MarketScan;
        if (data && Array.isArray(data.topCandidates)) setLiveScan(data);
      }
    } catch {
      /* keep the captured scan as fallback */
    } finally {
      setScanLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshScan();
  }, [refreshScan]);

  const scan = liveScan ?? snapshot.latestStrategyRun?.marketScan;
  if (!scan) {
    return (
      <Card>
        <PanelHeader
          title="Market scan"
          icon={<LineChartIcon size={16} />}
          actions={
            <IconButton label="Run scan" onClick={() => void refreshScan()} disabled={scanLoading}>
              <RefreshCw size={14} className={cn(scanLoading && "animate-spin")} />
            </IconButton>
          }
        />
        <EmptyState icon={<LineChartIcon size={20} />} title={scanLoading ? "Scanning the market…" : "No market scan yet"} hint="Refresh to scan the current market, or run the strategy to capture one." />
      </Card>
    );
  }
  const cols = SCAN_COLUMNS.filter((c) => visible.includes(c.id));
  // The quote `asOf` is a display string, not a timestamp; the scan's ISO generatedAt
  // is the real "received" time for every value in this table.
  const dataReceived = receivedLabel(scan.generatedAt);
  const sortCol = SCAN_COLUMNS.find((c) => c.id === sort.col);
  const sorted = sortCol
    ? [...scan.topCandidates].sort((a, b) => compare(scanSortValue(sortCol, a), scanSortValue(sortCol, b), sort.dir))
    : [...scan.topCandidates];
  return (
    <Card className="overflow-hidden">
      <PanelHeader
        title="Market scan"
        subtitle={`${scan.returnedQuotes} quotes · ${formatSources(scan.source)}${liveScan ? " · live" : scan.cached ? " · cached" : ""}`}
        icon={<LineChartIcon size={16} />}
        actions={
          <div className="flex items-center gap-1.5">
            <Chip tone="neutral">{new Date(scan.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</Chip>
            <IconButton label="Refresh scan" onClick={() => void refreshScan()} disabled={scanLoading}>
              <RefreshCw size={14} className={cn(scanLoading && "animate-spin")} />
            </IconButton>
            <div className="relative">
              <IconButton label="Configure columns" onClick={() => setColsOpen((v) => !v)}>
                <SettingsIcon size={14} />
              </IconButton>
              {colsOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setColsOpen(false)} />
                  <div className="absolute right-0 z-20 mt-1 max-h-[60vh] w-48 overflow-auto rounded-lg border border-line bg-surface/50 backdrop-blur-xl p-1.5 shadow-[var(--shadow-lg)]">
                    <p className="px-2 py-1 text-[11px] font-semibold uppercase text-faint">Show columns</p>
                    {SCAN_COLUMNS.map((c) => (
                      <label key={c.id} className={cn("flex items-center gap-2 rounded px-2 py-1 text-[13px] text-muted", c.id === "symbol" ? "opacity-50" : "cursor-pointer hover:bg-surface-2/50 backdrop-blur-lg")} title={c.title}>
                        <input type="checkbox" checked={visible.includes(c.id)} onChange={() => toggleCol(c.id)} disabled={c.id === "symbol"} className="accent-[var(--accent)]" />
                        {c.label}
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        }
      />
      <div className="p-2 h-[600px]">
        <TableVirtuoso
          data={sorted}
          components={{
            Table: (props) => <table {...props} className="w-full text-[13px]" />,
            TableHead: React.forwardRef((props, ref) => <thead {...props} ref={ref} className="bg-surface/50 backdrop-blur-xl" />),
            TableRow: (props) => <tr {...props} onClick={() => onDrilldown(props.item)} className="border-b border-line/50 hover:bg-surface-2/50 backdrop-blur-lg cursor-pointer transition-colors" />,
          }}
          fixedHeaderContent={() => (
            <tr className="border-b border-line text-[11px] uppercase text-faint bg-surface/50 backdrop-blur-xl shadow-sm">
              {cols.map((c) => (
                <th
                  key={c.id}
                  title={c.title}
                  onClick={() => setSort((s) => ({ col: c.id, dir: s.col === c.id && s.dir === "desc" ? "asc" : "desc" }))}
                  className={cn("cursor-pointer select-none whitespace-nowrap px-2.5 py-2 font-semibold hover:text-fg", c.align === "right" ? "text-right" : "text-left")}
                >
                  {c.label}
                  <span className="ml-0.5 text-faint">{sort.col === c.id ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
                </th>
              ))}
            </tr>
          )}
          itemContent={(index, q) => (
            <>
              {cols.map((c) => (
                <td key={c.id} title={[c.cellTitle?.(q), dataReceived].filter(Boolean).join("\n") || undefined} className={cn("px-2.5 py-1.5", c.align === "right" && "text-right", c.cellClass?.(q))}>
                  {c.id === "symbol" ? (
                    <SymbolButton symbol={q.symbol} quote={q} onDrilldown={onDrilldown} className="font-semibold text-fg" title={q.companyName ?? "Open symbol intelligence"} />
                  ) : (
                    c.render(q)
                  )}
                </td>
              ))}
            </>
          )}
        />
      </div>
    </Card>
  );
}

export function SmartMoneyView({ snapshot, scan, onDrilldown }: { snapshot: DashboardSnapshot; scan: MarketScan | null; onDrilldown: (q: MarketQuote) => void }) {
  const sm = snapshot.smartMoney;
  const ws = snapshot.webSources;
  const congress = sm?.congress ?? [];
  const insider = sm?.insider ?? [];
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card className="overflow-hidden">
        <PanelHeader
          title="Congressional trades"
          subtitle={ws?.congress ? `${ws.congress.recordCount} on file · ${ws.congress.sources.join("+") || "—"} · ${freshness(ws.congress.fetchedAt)}` : "Senate eFD + Capitol Trades"}
          icon={<Landmark size={16} />}
        />
        {congress.length === 0 ? (
          <EmptyState icon={<Landmark size={20} />} title="No disclosures cached yet" hint="The connector refreshes daily in the background; check back after the next refresh." />
        ) : (
          <div className="max-h-72 overflow-auto p-2">
            {congress.map((t, i) => (
              <div key={`${t.symbol}-${t.member}-${t.tradedAt}-${i}`} className="flex items-center gap-2 border-b border-line/50 px-2 py-1.5 text-[13px] last:border-0">
                <Chip tone={t.side === "buy" ? "up" : "down"}>{t.side === "buy" ? "BUY" : "SELL"}</Chip>
                <SymbolButton symbol={t.symbol} scan={scan} onDrilldown={onDrilldown} className="font-semibold text-fg" title={companyTitle(t.symbol, snapshot.symbolMetaBySymbol ?? {})} />
                <span className="truncate text-muted" title={`${t.member} (${t.chamber})`}>{t.member}</span>
                <span className="ml-auto whitespace-nowrap text-faint">{t.tradedAt}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <PanelHeader
          title="Insider (Form 4) activity"
          subtitle={ws?.insider ? `${ws.insider.recordCount} on file · SEC EDGAR · ${freshness(ws.insider.fetchedAt)}` : "SEC EDGAR — open-market buys/sells only"}
          icon={<Shield size={16} />}
        />
        {insider.length === 0 ? (
          <EmptyState icon={<Shield size={20} />} title="No insider filings cached yet" hint="Open-market Form 4 buys/sells accumulate here as they're filed." />
        ) : (
          <div className="max-h-72 overflow-auto p-2">
            {insider.map((f, i) => {
              const net = f.buyTx - f.sellTx;
              return (
                <div key={`${f.symbol}-${f.owner}-${f.filedAt}-${i}`} className="flex items-center gap-2 border-b border-line/50 px-2 py-1.5 text-[13px] last:border-0">
                  <Chip tone={net > 0 ? "up" : net < 0 ? "down" : "neutral"}>{net > 0 ? "BUY" : net < 0 ? "SELL" : "MIXED"}</Chip>
                  <SymbolButton symbol={f.symbol} scan={scan} onDrilldown={onDrilldown} className="font-semibold text-fg" title={companyTitle(f.symbol, snapshot.symbolMetaBySymbol ?? {})} />
                  <span className="truncate text-muted" title={f.owner}>{f.owner}</span>
                  <span className="ml-auto whitespace-nowrap text-faint">{f.filedAt}</span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

export function PerformanceView({
  snapshot,
  mode,
  symbolMetaBySymbol
}: {
  snapshot: DashboardSnapshot;
  mode: "paper" | "live";
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
}) {
  const perf = snapshot.performance;
  const curve = mode === "paper" ? perf?.paperEquityCurve ?? [] : perf?.liveEquityCurve ?? [];
  const realizedGross = mode === "paper" ? perf?.paperRealizedPnl ?? 0 : perf?.liveRealizedPnl ?? 0;
  // Optionally net realized P&L of the estimated tax burden (toggle in Settings → Tax).
  const subtractTax = Boolean(snapshot.policy.taxSettings?.subtractFromResults && snapshot.tax);
  const taxBurden = subtractTax ? snapshot.tax!.estimatedTaxLiability : 0;
  const realized = realizedGross - taxBurden;
  const unrealized = mode === "paper" ? perf?.paperUnrealizedPnl ?? 0 : perf?.liveUnrealizedPnl ?? 0;
  const winRate = mode === "paper" ? perf?.paperWinRate ?? 0 : perf?.liveWinRate ?? 0;
  const avgReturn = mode === "paper" ? perf?.paperAverageReturnPct ?? 0 : perf?.liveAverageReturnPct ?? 0;
  const thesis = (snapshot.thesisScorecard ?? []).map((t) => ({ label: t.thesisTag, pnl: t.totalPnl, winRate: t.winRate, trades: t.trades }));
  const regime = (snapshot.regimeScorecard ?? []).map((r) => ({ label: r.regime, pnl: r.totalPnl, winRate: r.winRate, trades: r.trades }));

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <PanelHeader title="Equity" subtitle={mode === "paper" ? "Mock/Local account" : "Live account"} icon={<TrendingUp size={16} />} />
        <div className="grid grid-cols-2 gap-2 px-4 pt-3 sm:grid-cols-4">
          <StatTile label={subtractTax ? "Realized (after est. tax)" : "Realized"} value={signedMoney(realized)} tone={realized >= 0 ? "up" : "down"} sub={subtractTax ? `−${money(taxBurden)} est. tax` : undefined} title="Profit/loss locked in by closing positions (FIFO matched). Toggle after-tax in Settings → Tax." />
          <StatTile label="Unrealized" value={signedMoney(unrealized)} tone={unrealized >= 0 ? "up" : "down"} title="Mock/Local gain/loss on positions still open, marked to current prices." />
          <StatTile label="Win rate" value={`${winRate.toFixed(0)}%`} title="Share of closed lots that were profitable." />
          <StatTile label="Avg return" value={`${avgReturn.toFixed(2)}%`} tone={avgReturn >= 0 ? "up" : "down"} title="Average percentage return per closed lot." />
        </div>
        <div className="h-64 p-4">
          <EquityCurve data={curve} />
        </div>
      </Card>

      <Card>
        <PanelHeader title="What's working — by thesis" subtitle="Realized P&L grouped by trade thesis (the learning loop)" icon={<BrainCircuit size={16} />} />
        <div className="p-4 pt-3">
          <ScorecardBars data={thesis} />
        </div>
      </Card>

      <Card>
        <PanelHeader title="By market regime" subtitle="Realized P&L grouped by entry regime" icon={<Gauge size={16} />} />
        <div className="p-4 pt-3">
          <ScorecardBars data={regime} />
        </div>
      </Card>
    </div>
  );
}

export function TaxView({
  snapshot,
  symbolMetaBySymbol,
  scan,
  onDrilldown
}: {
  snapshot: DashboardSnapshot;
  symbolMetaBySymbol: DashboardSnapshot["symbolMetaBySymbol"];
  scan: MarketScan | null;
  onDrilldown: (q: MarketQuote) => void;
}) {
  const tax = snapshot.tax;
  if (!tax) {
    return (
      <Card>
        <PanelHeader title="Tax" icon={<Landmark size={16} />} />
        <EmptyState icon={<Landmark size={20} />} title="No tax data yet" hint="Select an account and run the strategy; realized gains and lots appear here." />
      </Card>
    );
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <PanelHeader
          title={`Tax overview · ${tax.taxYear}`}
          subtitle="Rough estimates only — not tax advice. Consult a CPA."
          icon={<Landmark size={16} />}
          actions={<Chip tone={tax.settings.washSaleGuard ? "up" : "warn"}>Wash-sale guard {tax.settings.washSaleGuard ? "on" : "off"}</Chip>}
        />
        <div className="grid grid-cols-2 gap-2 p-4 pt-3 sm:grid-cols-4">
          <StatTile label="Short-term realized" value={signedMoney(tax.shortTermRealized)} tone={tax.shortTermRealized >= 0 ? "up" : "down"} sub={`taxed ~${tax.settings.shortTermRatePct}% (ordinary)`} />
          <StatTile label="Long-term realized" value={signedMoney(tax.longTermRealized)} tone={tax.longTermRealized >= 0 ? "up" : "down"} sub={`taxed ~${tax.settings.longTermRatePct}%`} />
          <StatTile label="Est. tax liability" value={money(tax.estimatedTaxLiability)} tone="down" sub="this year, on realized gains" />
          <StatTile label="Disallowed (wash sale)" value={money(tax.disallowedWashSaleLoss)} tone={tax.disallowedWashSaleLoss > 0 ? "warn" : "neutral"} sub="losses you can't deduct" />
        </div>
      </Card>

      <Card>
        <PanelHeader title="Wash-sale lockout" subtitle="Rebuying these is blocked 30 days after a loss sale" icon={<Shield size={16} />} />
        <div className="space-y-3 p-4 pt-3">
          {tax.lockedSymbols.length === 0 ? (
            <p className="text-[13px] text-faint">No symbols are currently locked out.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {tax.lockedSymbols.map((s) => (
                <Chip key={s} tone="down">
                  <SymbolButton symbol={s} scan={scan} onDrilldown={onDrilldown} variant="chip" title={companyTitle(s, symbolMetaBySymbol)} />
                </Chip>
              ))}
            </div>
          )}
          {tax.washSales.length > 0 && (
            <div className="space-y-1.5 border-t border-line pt-3">
              <span className="text-xs font-medium text-muted">Wash sales detected this year</span>
              {tax.washSales.slice(0, 6).map((w, i) => (
                <div key={`${w.symbol}-${i}`} className="flex items-center justify-between text-[13px]">
                  <SymbolButton symbol={w.symbol} scan={scan} onDrilldown={onDrilldown} className="font-semibold text-fg" title={companyTitle(w.symbol, symbolMetaBySymbol)} />
                  <span className="tnum text-faint">{new Date(w.soldAt).toLocaleDateString()} · {money(w.disallowedLoss)} disallowed</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Card>
        <PanelHeader title="Tax-loss harvest candidates" subtitle="Unrealized losers that could offset realized gains" icon={<Percent size={16} />} />
        <div className="p-4 pt-3">
          {tax.harvestCandidates.length === 0 ? (
            <p className="text-[13px] text-faint">No harvestable losses right now.</p>
          ) : (
            <table className="w-full text-[13px]">
              <tbody>
                {tax.harvestCandidates.map((h) => (
                  <tr key={h.symbol} className="border-b border-line/50">
                    <td className="py-1.5 font-semibold text-fg"><SymbolButton symbol={h.symbol} scan={scan} onDrilldown={onDrilldown} title={companyTitle(h.symbol, symbolMetaBySymbol)} /></td>
                    <td className="py-1.5 text-right tnum text-muted">{formatShareQuantity(h.quantity, h.symbol)} sh</td>
                    <td className="py-1.5 text-right tnum text-down">{signedMoney(h.unrealizedLoss)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      <Card className="lg:col-span-2">
        <PanelHeader title="Holding period — days to long-term" subtitle="Crossing 1 year flips gains from ordinary to long-term rates" icon={<Hourglass size={16} />} />
        <div className="min-h-0 overflow-auto p-2">
          {tax.openLots.length === 0 ? (
            <EmptyState icon={<Hourglass size={18} />} title="No open lots" />
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase text-faint">
                  <th className="px-2 py-1.5 text-left font-semibold">Symbol</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Qty</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Days held</th>
                  <th className="px-2 py-1.5 text-left font-semibold">Progress to long-term</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {tax.openLots.map((lot, i) => (
                  <tr key={`${lot.symbol}-${i}`} className="border-b border-line/50">
                    <td className="px-2 py-1.5 font-semibold text-fg"><SymbolButton symbol={lot.symbol} scan={scan} onDrilldown={onDrilldown} title={companyTitle(lot.symbol, symbolMetaBySymbol)} /></td>
                    <td className="px-2 py-1.5 text-right tnum text-muted">{formatShareQuantity(lot.quantity, lot.symbol)}</td>
                    <td className="px-2 py-1.5 text-right tnum text-muted">{lot.daysHeld}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="h-1.5 w-32 overflow-hidden rounded-full bg-surface-3/50 backdrop-blur-md">
                          <span className={cn("block h-full rounded-full", lot.isLongTerm ? "bg-up" : "bg-info")} style={{ width: `${Math.min(100, (lot.daysHeld / 365) * 100)}%` }} />
                        </span>
                        <span className="tnum text-[11px] text-faint">{lot.isLongTerm ? "—" : `${lot.daysToLongTerm}d left`}</span>
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Chip tone={lot.isLongTerm ? "up" : "warn"}>{lot.isLongTerm ? "Long-term" : "Short-term"}</Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}

export function StrategyView({
  snapshot,
  policy,
  updatePolicy,
  onEdit,
  activateProfile,
  newProfileName,
  setNewProfileName,
  createProfile,
  requestStrategyTuning,
  tuningBusy,
  tuningError,
  strategyTuning,
  applyStrategyTuning
}: {
  snapshot: DashboardSnapshot;
  policy: TradingPolicy;
  updatePolicy: (patch: PolicyPatch) => void;
  onEdit: () => void;
  activateProfile: (id: string) => void;
  newProfileName: string;
  setNewProfileName: (v: string) => void;
  createProfile: () => void;
  requestStrategyTuning: () => void;
  tuningBusy: boolean;
  tuningError: string;
  strategyTuning: StrategyTuningProposal | null;
  applyStrategyTuning: () => void;
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <PanelHeader
          title="Active strategy"
          subtitle={policy.strategyAuthority === "decide" ? "LLM decides autonomously" : "LLM proposes, you approve"}
          icon={<BrainCircuit size={16} />}
          actions={<Button size="sm" variant="ghost" onClick={onEdit}><SettingsIcon size={14} /> Edit in Studio</Button>}
        />
        <div className="grid gap-3 p-4 pt-3 sm:grid-cols-2">
          <div>
            <span className="mb-1.5 block text-xs font-medium text-muted">Saved strategy</span>
            <select className={inputClass} value={snapshot.activeProfile?.id ?? ""} onChange={(e) => activateProfile(e.target.value)}>
              {snapshot.profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            <span className="mb-1.5 block text-xs font-medium text-muted">Save current as a named strategy</span>
            <div className="flex items-center gap-2">
              <input
                className={inputClass}
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                placeholder="Name this strategy"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    createProfile();
                  }
                }}
              />
              <Button onClick={createProfile} disabled={!newProfileName.trim()}>Save</Button>
              <span className="text-xs text-faint">Optional</span>
            </div>
          </div>
        </div>
        <div className="px-4 pb-4">
          <span className="mb-1.5 block text-xs font-medium text-muted">Prompt</span>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-bg/60 p-3 text-[13px] leading-relaxed text-muted">
            {snapshot.strategyPrompt}
          </pre>
        </div>
      </Card>

      <Card>
        <PanelHeader title="Key parameters" subtitle="Edit inline — applies immediately" icon={<Shield size={16} />} />
        <div className="grid grid-cols-2 gap-2 p-4 pt-3 text-sm">
          <EditableParam label="Max order" absValue={policy.maxOrderNotional} relValue={policy.maxOrderPctOfNav} onCommitAbs={(v) => updatePolicy({ maxOrderNotional: v })} onCommitRel={(v) => updatePolicy({ maxOrderPctOfNav: v })} defaultMode="rel" />
          <EditableParam label="Daily cap" absValue={policy.maxDailyNotional} relValue={policy.maxDailyPctOfNav} onCommitAbs={(v) => updatePolicy({ maxDailyNotional: v })} onCommitRel={(v) => updatePolicy({ maxDailyPctOfNav: v })} defaultMode="abs" />
          <EditableParam label="Symbol cap" relValue={policy.maxSymbolExposurePct} onCommitAbs={() => {}} onCommitRel={(v) => updatePolicy({ maxSymbolExposurePct: v })} defaultMode="rel" />
          <EditableParam label="Stop loss" absValue={policy.riskRules.stopLossNotional} relValue={policy.riskRules.stopLossPct} onCommitAbs={(v) => updatePolicy({ riskRules: { ...policy.riskRules, stopLossNotional: v } })} onCommitRel={(v) => updatePolicy({ riskRules: { ...policy.riskRules, stopLossPct: v } })} defaultMode="rel" />
          <EditableParam label="Take profit" absValue={policy.riskRules.takeProfitNotional} relValue={policy.riskRules.takeProfitPct} onCommitAbs={(v) => updatePolicy({ riskRules: { ...policy.riskRules, takeProfitNotional: v } })} onCommitRel={(v) => updatePolicy({ riskRules: { ...policy.riskRules, takeProfitPct: v } })} defaultMode="rel" />

          <div className="col-span-2 mt-2 space-y-3">
             <div className="grid grid-cols-2 gap-2">
               <NumberField label="Max proposals/run" value={policy.maxProposalsPerRun} onCommit={(v) => updatePolicy({ maxProposalsPerRun: Math.round(v) })} />
               <NumberField label="Cadence (min)" value={policy.runCadenceMinutes} onCommit={(v) => updatePolicy({ runCadenceMinutes: Math.max(1, Math.round(v)) })} />
               <NumberField label="Max daily orders" value={policy.maxDailyOrders} onCommit={(v) => updatePolicy({ maxDailyOrders: Math.round(v) })} />
             </div>
             <Field label="Sector caps" hint="e.g. Technology:25, Financials:20" className="sm:col-span-2">
               <input className="w-full rounded-md border border-line bg-surface-3/50 px-3 py-2 text-[13px] text-fg outline-none focus:border-accent" defaultValue={formatSectorCaps(policy.sectorCaps)} onBlur={(e) => updatePolicy({ sectorCaps: parseSectorCaps(e.target.value) })} />
             </Field>
             <div className="space-y-1 sm:col-span-2">
               <label className="flex items-center gap-2 text-sm text-muted">
                 <input type="checkbox" checked={policy.runDuringExtendedHours} onChange={(e) => updatePolicy({ runDuringExtendedHours: e.target.checked })} />
                 Run during extended hours
               </label>
               <p className="text-xs leading-relaxed text-faint">
                 Allows scheduled or event-triggered strategy runs during 4:00-9:30 AM ET and 4:00-8:00 PM ET. Extended-hours orders still require the separate order permission, and dollar/fractional orders stay regular-hours only.
               </p>
             </div>
          </div>
        </div>
      </Card>

      <Card>
        <PanelHeader title="LLM strategy review" subtitle="Advisory — review past performance & suggest tuning" icon={<Sparkles size={16} />} actions={<Button size="sm" onClick={requestStrategyTuning} disabled={tuningBusy}><Zap size={14} /> {tuningBusy ? "Reviewing…" : "Review"}</Button>} />
        <div className="p-4 pt-3">
          {tuningError && <p className="mb-2 rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-[13px] text-down">{tuningError}</p>}
          {strategyTuning ? <TuningCard proposal={strategyTuning} onApply={applyStrategyTuning} /> : <p className="text-[13px] text-faint">No review yet. Run a review to get suggested prompt, scoring, and risk changes (you apply them manually).</p>}
        </div>
      </Card>
    </div>
  );
}

export function ActivityFeed({ snapshot }: { snapshot: DashboardSnapshot }) {
  const feed = snapshot.unifiedFeed ?? [];
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (feed.length === 0) return <EmptyState icon={<ActivityIcon size={18} />} title="No activity yet" />;
  return (
    <div className="space-y-2">
      {feed.slice(0, 50).map((group) => {
        const accent = group.tags.includes("policy change")
          ? "border-l-info"
          : group.status === "filled"
            ? "border-l-up"
            : group.status === "blocked" || group.status === "rejected"
              ? "border-l-down"
              : group.status === "pending_approval" || group.status === "pending"
                ? "border-l-warn"
                : "border-l-line";
        const hasSub = group.events && group.events.length > 1;
        const open = !!expanded[group.id];
        return (
          <div key={group.id} className={cn("rounded-r-lg border-l-[3px] border-b border-line bg-surface-2/40 pl-3", accent)}>
            <div className="flex items-start justify-between gap-2 py-2 pr-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-faint">
                  <span>{new Date(group.updatedAt).toLocaleString()}</span>
                  {group.companyName && <span>({group.companyName})</span>}
                </div>
                <div className="mt-0.5 text-sm">{renderActionTitle(group.title)}</div>
                <div className="mt-0.5 text-[13px] text-muted">{group.detail}</div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {group.tags.map((t) => (
                    <span key={t} className="rounded bg-surface-3/50 backdrop-blur-md px-1.5 py-0.5 text-[10px] font-semibold uppercase text-faint">{t}</span>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <Chip tone={statusTone(group.status)}>{group.status.replace(/_/g, " ")}</Chip>
                {hasSub && (
                  <button onClick={() => setExpanded((e) => ({ ...e, [group.id]: !e[group.id] }))} className="text-[11px] text-muted hover:text-fg">
                    {open ? "Hide" : `+${group.events.length}`}
                  </button>
                )}
              </div>
            </div>
            {open && hasSub && (
              <div className="space-y-1 border-t border-dashed border-line py-2 pr-2">
                {group.events.map((ev) => (
                  <div key={ev.id} className="flex gap-2 text-[12px]">
                    <span className="w-24 shrink-0 text-faint">{new Date(ev.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                    <div className="flex-1">
                      <div>{renderActionTitle(ev.title)}</div>
                      <div className="text-[11px] text-faint">{ev.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function RunHistory({ snapshot }: { snapshot: DashboardSnapshot }) {
  const runs = snapshot.strategyRuns ?? [];
  if (runs.length === 0) return <EmptyState icon={<Zap size={18} />} title="No strategy runs yet" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line text-[11px] uppercase text-faint">
            <th className="px-2 py-1.5 text-left font-semibold">Time</th>
            <th className="px-2 py-1.5 text-left font-semibold">Status</th>
            <th className="px-2 py-1.5 text-right font-semibold">Placed</th>
            <th className="px-2 py-1.5 text-right font-semibold">Mock/Local</th>
            <th className="px-2 py-1.5 text-right font-semibold">Blocked</th>
            <th className="px-2 py-1.5 text-left font-semibold">Summary</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} className="border-b border-line/50">
              <td className="whitespace-nowrap px-2 py-1.5 text-muted">{new Date(run.startedAt).toLocaleString()}</td>
              <td className="px-2 py-1.5"><Chip tone={run.status === "completed" ? "up" : run.status === "failed" ? "down" : "warn"}>{run.status}</Chip></td>
              <td className="px-2 py-1.5 text-right tnum">{run.placedCount}</td>
              <td className="px-2 py-1.5 text-right tnum">{run.paperCount}</td>
              <td className="px-2 py-1.5 text-right tnum">{run.blockedCount}</td>
              <td className="max-w-[220px] truncate px-2 py-1.5 text-faint" title={run.summary}>{run.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function NotificationsList({ snapshot }: { snapshot: DashboardSnapshot }) {
  const items = snapshot.notifications ?? [];
  const configured = snapshot.notificationStatus.configured;
  const meta = snapshot.symbolMetaBySymbol ?? {};
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Chip tone={configured ? "up" : "warn"}>{configured ? "Webhook configured" : "Webhook not configured"}</Chip>
      </div>
      {items.length === 0 ? (
        <EmptyState title="No notification attempts recorded" />
      ) : (
        items.slice(0, 20).map((n) => {
          const display = formatNotificationDisplay(n, meta);
          return (
            <div key={n.id} className="border-b border-line/60 py-2">
              <div className="text-[11px] uppercase text-faint">{display.timestamp}</div>
              <div className="text-sm text-fg">{display.title}</div>
              <div className="text-[13px] text-muted">{display.detail}</div>
            </div>
          );
        })
      )}
    </div>
  );
}
