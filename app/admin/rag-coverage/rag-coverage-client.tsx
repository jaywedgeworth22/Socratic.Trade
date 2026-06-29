"use client";

import { useEffect, useState, useCallback } from "react";
import { Card } from "../../ui/primitives";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TickerCoverage {
  symbol: string;
  filings: number;
  chunks: number;
  latestChunkAt: string | null;
}

interface CoverageData {
  sinceDays: number;
  perTicker: TickerCoverage[];
  totalTickers: number;
  totalChunks: number;
  totalFilings: number;
  vectorStoreTotalVectors: number;
  coverageGaps: string[];
  ragUsage: {
    sinceDays: number;
    totalCostUsd: number;
    rows: Array<{
      userId: string;
      operation: string;
      provider: string;
      model: string | null;
      calls: number;
      tokensIn: number;
      tokensOut: number;
      batchCount: number;
      costEstUsd: number;
    }>;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}

function fmtRelDate(iso: string | null): string {
  if (!iso) return "never";
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function opLabel(op: string): string {
  const map: Record<string, string> = {
    embed: "Embed",
    rerank: "Rerank",
    query: "Query",
    upsert: "Upsert"
  };
  return map[op] ?? op;
}

function providerLabel(provider: string): string {
  const map: Record<string, string> = {
    voyage: "Voyage",
    pinecone: "Pinecone"
  };
  return map[provider] ?? provider;
}

// ── Components ────────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4 flex flex-col gap-1">
      <div className="text-xs text-muted uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-semibold text-fg">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </Card>
  );
}

function TickerRow({ coverage }: { coverage: TickerCoverage }) {
  const maxChunks = 200; // reasonable visual scale cap
  const barPct = Math.min(100, Math.round((coverage.chunks / maxChunks) * 100));
  return (
    <div className="flex items-center gap-3 py-2 border-b border-line/30 last:border-0 text-sm">
      <div className="w-16 font-mono font-semibold text-fg shrink-0">{coverage.symbol}</div>
      <div className="flex-1 min-w-0">
        <div className="h-2 bg-surface-2 rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all"
            style={{ width: `${barPct}%` }}
          />
        </div>
        <div className="flex items-center gap-3 mt-1 text-xs text-muted">
          <span>{coverage.chunks} chunks</span>
          <span>{coverage.filings} filing{coverage.filings !== 1 ? "s" : ""}</span>
          <span>{fmtRelDate(coverage.latestChunkAt)}</span>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

const WINDOW_OPTIONS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 }
];

export function RagCoverageClient() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<CoverageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ sinceDays: String(days) });
      const res = await fetch(`/api/admin/rag-coverage?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const filtered = data
    ? data.perTicker.filter((t) =>
        t.symbol.toLowerCase().includes(search.toLowerCase())
      )
    : [];

  return (
    <div className="min-h-screen bg-base text-fg p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-fg">RAG Corpus Coverage</h1>
        <p className="text-sm text-muted mt-1">
          What&apos;s in the vector index per ticker — chunk counts, freshness, and coverage gaps.
        </p>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <div className="flex items-center gap-1 bg-surface-2 border border-line rounded-lg p-0.5">
          {WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              onClick={() => setDays(opt.days)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                days === opt.days
                  ? "bg-accent text-accent-fg"
                  : "text-muted hover:text-fg"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Filter ticker…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="text-sm border border-line bg-surface rounded-lg px-3 py-1.5 text-fg placeholder:text-muted focus:outline-none focus:border-accent/50 min-w-[140px]"
        />
        <button
          onClick={fetchData}
          disabled={loading}
          className="ml-auto text-xs text-muted hover:text-fg border border-line rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="text-sm text-down bg-down/10 border border-down/20 rounded-lg p-3 mb-4">
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Summary row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <SummaryCard
              label="Tickers indexed"
              value={String(data.totalTickers)}
            />
            <SummaryCard
              label="Total chunks"
              value={String(data.totalChunks)}
              sub={`${data.totalFilings} filing${data.totalFilings !== 1 ? "s" : ""}`}
            />
            <SummaryCard
              label="Pinecone vectors"
              value={String(data.vectorStoreTotalVectors)}
            />
            <SummaryCard
              label="RAG cost"
              value={fmtCost(data.ragUsage.totalCostUsd)}
              sub={`last ${data.sinceDays}d`}
            />
          </div>

          {/* Coverage gaps warning */}
          {data.coverageGaps.length > 0 && (
            <div className="text-sm text-down bg-down/10 border border-down/20 rounded-lg p-3 mb-4">
              <strong>{data.coverageGaps.length} ticker{data.coverageGaps.length !== 1 ? "s" : ""} have filing records but zero chunks in the index:</strong>{" "}
              {data.coverageGaps.join(", ")}
            </div>
          )}

          {/* Per-ticker list */}
          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b border-line text-xs text-muted uppercase tracking-wide flex items-center gap-3">
              <span className="w-16 shrink-0">Ticker</span>
              <span className="flex-1">Chunk coverage</span>
            </div>
            <div className="px-4 divide-y divide-line/20 max-h-[60vh] overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="text-sm text-muted text-center py-12">
                  {search ? "No tickers match your filter." : "No indexed filings yet."}
                </div>
              ) : (
                filtered.map((t) => <TickerRow key={t.symbol} coverage={t} />)
              )}
            </div>
          </Card>

          {/* RAG usage table */}
          {data.ragUsage.rows.length > 0 && (
            <div className="mt-6">
              <h2 className="text-sm font-semibold text-fg mb-2">RAG Usage</h2>
              <Card className="overflow-hidden">
                <div className="px-4 py-2 border-b border-line text-xs text-muted uppercase tracking-wide flex items-center gap-3">
                  <span className="w-24 shrink-0">Operation</span>
                  <span className="w-20 shrink-0">Provider</span>
                  <span className="flex-1">Model</span>
                  <span className="w-16 text-right">Calls</span>
                  <span className="w-20 text-right">Cost</span>
                </div>
                <div className="divide-y divide-line/20 max-h-[30vh] overflow-y-auto">
                  {data.ragUsage.rows.map((row, i) => (
                    <div key={i} className="px-4 py-2 flex items-center gap-3 text-xs">
                      <span className="w-24 shrink-0 font-mono text-fg/80">{opLabel(row.operation)}</span>
                      <span className="w-20 shrink-0 text-muted">{providerLabel(row.provider)}</span>
                      <span className="flex-1 text-muted truncate">{row.model ?? "—"}</span>
                      <span className="w-16 text-right font-mono text-muted">{row.calls}</span>
                      <span className="w-20 text-right font-mono text-fg">{fmtCost(row.costEstUsd)}</span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          )}
        </>
      )}

      {loading && !data && (
        <div className="text-sm text-muted text-center py-12">Loading…</div>
      )}
    </div>
  );
}
