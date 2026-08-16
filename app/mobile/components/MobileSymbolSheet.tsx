"use client";

import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";

type QuoteInfo = {
  symbol?: string;
  companyName?: string;
  price?: number;
  intradayChangePct?: number;
  asOf?: string;
  volume?: number;
  peRatio?: number;
  eps?: number;
  dividendYield?: number;
  beta?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  sector?: string;
  industry?: string;
  error?: string;
};

type PositionFacts = {
  symbol: string;
  quantity: number;
  marketValue: number;
  averageCost?: number;
};

type DeskPeer = {
  accountId: string;
  label: string;
  environment?: string;
  direction: "long" | "short";
  quantity: number;
};

type DeskExit = {
  style?: string;
  rationale?: string;
  stopPrice?: number;
  takeProfitPrice?: number;
  trailPercent?: number;
  resolvedStopPct?: number;
  invalidation?: string;
  trimBand?: number;
};

type DeskPending = {
  id: string;
  side: string;
  quantity?: number;
  rationale?: string;
};

type SymbolDesk = {
  peerAccounts?: DeskPeer[];
  exit?: DeskExit;
  pending?: DeskPending[];
};

function money(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function number(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function percent(value: unknown, signed = false): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const body = `${Math.abs(n).toFixed(2)}%`;
  if (!signed) return body;
  if (n > 0) return `+${body}`;
  if (n < 0) return `-${body}`;
  return body;
}

/** n/a = negative/zero earnings (real no-ratio).  — = unavailable. */
function peDisplay(peRatio?: number, eps?: number): string {
  if (typeof eps === "number" && Number.isFinite(eps) && eps <= 0) return "n/a";
  if (typeof peRatio === "number" && Number.isFinite(peRatio) && peRatio > 0) return peRatio.toFixed(1);
  return "—";
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-surface p-3">
      <p className="text-xs uppercase tracking-wide text-faint">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold">{value}</p>
    </div>
  );
}

export function MobileSymbolSheet({
  symbol,
  position,
  onClose
}: {
  symbol: string;
  position?: PositionFacts;
  onClose: () => void;
}) {
  const normalized = symbol.trim().toUpperCase();
  const [quote, setQuote] = useState<QuoteInfo | null>(null);
  const [desk, setDesk] = useState<SymbolDesk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [quoteRes, deskRes] = await Promise.all([
          fetch(`/api/quote?symbol=${encodeURIComponent(normalized)}`, { cache: "no-store" }),
          fetch(`/api/symbol-desk?symbol=${encodeURIComponent(normalized)}`, { cache: "no-store" })
        ]);
        const body = (await quoteRes.json().catch(() => ({}))) as QuoteInfo;
        if (cancelled) return;
        if (!quoteRes.ok) throw new Error(body.error ?? `quote ${quoteRes.status}`);
        setQuote(body);
        if (deskRes.ok) {
          setDesk((await deskRes.json()) as SymbolDesk);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Quote fetch failed.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [normalized]);

  const unrealized =
    position && typeof position.averageCost === "number"
      ? position.marketValue - position.quantity * position.averageCost
      : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="Close" onClick={onClose} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`${normalized} details`}
        className="relative z-10 max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-t-xl border border-line bg-bg p-4 text-fg shadow-lg sm:rounded-xl"
      >
        <header className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{normalized}</h2>
            {quote?.companyName ? <p className="text-sm text-muted">{quote.companyName}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-11 w-11 place-items-center rounded-md border border-line bg-surface"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {position ? (
          <div className="mb-3 space-y-2 rounded-md border border-line bg-surface p-3 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-faint">Position</p>
            <p>{number(Math.abs(position.quantity))} shares{position.quantity < 0 ? " short" : ""}</p>
            <p>Market value {money(position.marketValue)}</p>
            <p>Average cost {money(position.averageCost)}</p>
            {unrealized !== undefined ? <p>Open P&amp;L {money(unrealized)}</p> : null}
          </div>
        ) : null}

        {desk?.exit ? (
          <div className="mb-3 space-y-1 rounded-md border border-line bg-surface p-3 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-faint">Exit Plan</p>
            {desk.exit.style ? <p className="capitalize">{desk.exit.style} plan</p> : null}
            {typeof desk.exit.stopPrice === "number" ? <p>Stop {money(desk.exit.stopPrice)}</p> : null}
            {typeof desk.exit.takeProfitPrice === "number" ? <p>Take profit {money(desk.exit.takeProfitPrice)}</p> : null}
            {typeof desk.exit.trailPercent === "number" ? <p>Trail {percent(desk.exit.trailPercent)}</p> : null}
            {typeof desk.exit.trimBand === "number" ? <p>Take-profit band {desk.exit.trimBand} already harvested</p> : null}
            {desk.exit.invalidation ? <p className="text-muted">Kill condition: {desk.exit.invalidation}</p> : null}
            {desk.exit.rationale ? <p className="text-muted">{desk.exit.rationale}</p> : null}
          </div>
        ) : null}

        {(desk?.pending?.length ?? 0) > 0 ? (
          <div className="mb-3 space-y-2 rounded-md border border-line bg-surface p-3 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-faint">Waiting For You</p>
            {desk?.pending?.map((item) => (
              <p key={item.id}>
                {item.side.toUpperCase()}
                {typeof item.quantity === "number" ? ` ${number(item.quantity)} sh` : ""}
                {item.rationale ? ` — ${item.rationale}` : ""}
              </p>
            ))}
          </div>
        ) : null}

        {(desk?.peerAccounts?.length ?? 0) > 0 ? (
          <div className="mb-3 space-y-2 rounded-md border border-line bg-surface p-3 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-faint">Other Accounts</p>
            {desk?.peerAccounts?.map((peer) => (
              <p key={peer.accountId}>
                {peer.direction === "short" ? "Short" : "Long"} {number(peer.quantity)} sh on {peer.label}
                {peer.environment ? ` (${peer.environment})` : ""}
              </p>
            ))}
            <p className="text-xs text-faint">
              Size and direction only.  Switch accounts from Home to see that book.
            </p>
          </div>
        ) : null}

        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading {normalized}…
          </div>
        ) : error ? (
          <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100">
            {error}
          </p>
        ) : quote ? (
          <div className="space-y-3">
            <div>
              <p className="text-2xl font-semibold">{money(quote.price)}</p>
              {quote.intradayChangePct !== undefined ? (
                <p className={`text-sm font-semibold ${quote.intradayChangePct >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                  {percent(quote.intradayChangePct, true)} today
                </p>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Volume" value={number(quote.volume)} />
              <Stat label="P/E Ratio" value={peDisplay(quote.peRatio, quote.eps)} />
              <Stat label="EPS" value={money(quote.eps)} />
              <Stat label="Dividend Yield" value={percent(quote.dividendYield)} />
              <Stat label="Beta" value={number(quote.beta)} />
              <Stat label="52W High" value={money(quote.fiftyTwoWeekHigh)} />
              <Stat label="52W Low" value={money(quote.fiftyTwoWeekLow)} />
            </div>
            {quote.asOf ? (
              <p className="text-xs text-faint">
                Quote data from a live fetch ({new Date(quote.asOf).toLocaleString("en-US", {
                  timeZone: "America/Chicago",
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "numeric",
                  minute: "2-digit"
                })} CT).
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
