"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Brain,
  Database,
  Server,
  FileText,
  TrendingUp,
  Cpu,
  RefreshCw,
  ArrowRight,
  ShieldCheck,
  AlertTriangle
} from "lucide-react";
import { Card, Chip, Dot, Button } from "../ui/primitives";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ConnectionSummary {
  services: Array<{ service: string; stoppedWorking: boolean; callsLast24h: number }>;
}

interface LlmSummary {
  rows: Array<{ model: string | null; costEstUsd: number }>;
  totalCostUsd: number;
}

interface RagSummary {
  totalTickers: number;
  totalChunks: number;
  vectorStoreTotalVectors: number;
  globalBreakdown?: Record<string, number>;
}

interface ServerSummary {
  hostInfo: { cpuCount: number; ramTotalGb: number };
  resources: { cpuPct: number; ramUsedGb: number; diskFreeGb: number; diskTotalGb: number };
  containers: Array<{ name: string; status: string; state: string }>;
}

interface TranscriptSummary {
  turns: Array<{ id: string; role: string; text: string; model: string | null; createdAt: string }>;
}

export default function OperatorDashboard() {
  const [connections, setConnections] = useState<ConnectionSummary | null>(null);
  const [llm, setLlm] = useState<LlmSummary | null>(null);
  const [rag, setRag] = useState<RagSummary | null>(null);
  const [server, setServer] = useState<ServerSummary | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSummary | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchDashboardData = async () => {
    setError(null);
    try {
      const [resConn, resLlm, resRag, resServ, resTrans] = await Promise.all([
        fetch("/api/admin/connections-health"),
        fetch("/api/admin/llm-usage?sinceDays=30"),
        fetch("/api/admin/rag-coverage?sinceDays=30"),
        fetch("/api/admin/server-metrics"),
        fetch("/api/chat-history?limit=10")
      ]);

      if (!resConn.ok || !resLlm.ok || !resRag.ok || !resServ.ok || !resTrans.ok) {
        throw new Error("One or more API endpoints failed to load.");
      }

      setConnections(await resConn.json());
      setLlm(await resLlm.json());
      setRag(await resRag.json());
      setServer(await resServ.json());
      setTranscript(await resTrans.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load dashboard data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchDashboardData();
  };

  // Helper formats
  const fmtCost = (usd: number) => {
    if (usd === 0) return "$0.00";
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
  };

  const getSourceLabel = (src: string) => {
    if (src === "sec-edgar") return "SEC";
    if (src.startsWith("fundamentals:")) return "Fund Card";
    if (src.startsWith("disclosure:congress")) return "Congress";
    if (src.startsWith("disclosure:insider")) return "Insider";
    if (src.includes("socratic-memory")) return "Coach";
    if (src.startsWith("sec8k-summary")) return "8-K Summary";
    return src.split(":").pop() || src;
  };

  const getSourceTone = (src: string): "neutral" | "pos" | "neg" | "warn" | "info" | "accent" => {
    if (src === "sec-edgar") return "accent";
    if (src.startsWith("fundamentals:")) return "info";
    if (src.startsWith("disclosure:congress")) return "warn";
    if (src.startsWith("disclosure:insider")) return "neutral";
    if (src.includes("socratic-memory")) return "pos";
    if (src.startsWith("sec8k-summary")) return "neg";
    return "neutral";
  };

  const failedConnections = connections?.services.filter((s) => s.stoppedWorking) ?? [];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-fg flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-accent" />
            Operator Overview
          </h1>
          <p className="text-sm text-muted mt-1">
            Real-time status, diagnostics, and metrics across the Socratic Trade environment.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={loading || refreshing}
          onClick={handleRefresh}
          className="border border-line/40 rounded-xl"
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Refreshing..." : "Refresh"}
        </Button>
      </div>

      {error && (
        <Card className="p-4 border-neg/20 bg-neg/5 text-neg text-sm flex items-start gap-3 rounded-2xl">
          <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">Operator access required</span>
            <p className="mt-1 text-xs opacity-90">{error}</p>
          </div>
        </Card>
      )}

      {loading ? (
        <div className="py-20 text-center text-sm text-muted">Loading dashboard...</div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2">
          {/* ── 1. API Connections Card ──────────────────────────────────────── */}
          <Card className="flex flex-col h-full rounded-2xl overflow-hidden border-line/40">
            <div className="p-5 flex items-center justify-between border-b border-line/20">
              <div className="flex items-center gap-2.5">
                <Activity className="h-4 w-4 text-accent" />
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">API Connections</h2>
              </div>
              <Link href="/admin/connections" className="text-xs text-accent hover:underline flex items-center gap-0.5">
                Manage <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            <div className="p-5 flex-1 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted">Overall Health</span>
                <Chip tone={failedConnections.length > 0 ? "neg" : "pos"}>
                  {failedConnections.length > 0 ? `${failedConnections.length} Offline` : "All Operations Online"}
                </Chip>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {connections?.services.slice(0, 6).map((srv) => (
                  <div key={srv.service} className="bg-surface-2/40 border border-line/20 rounded-xl p-3 flex items-center justify-between">
                    <span className="text-xs font-medium font-mono truncate mr-2" title={srv.service}>
                      {srv.service}
                    </span>
                    <Dot tone={srv.stoppedWorking ? "neg" : srv.callsLast24h > 0 ? "pos" : "neutral"} pulse={srv.stoppedWorking} />
                  </div>
                ))}
              </div>
            </div>
          </Card>

          {/* ── 2. LLM Spend Card ────────────────────────────────────────────── */}
          <Card className="flex flex-col h-full rounded-2xl overflow-hidden border-line/40">
            <div className="p-5 flex items-center justify-between border-b border-line/20">
              <div className="flex items-center gap-2.5">
                <Brain className="h-4 w-4 text-accent" />
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">LLM Telemetry</h2>
              </div>
              <Link href="/admin/llm-usage" className="text-xs text-accent hover:underline flex items-center gap-0.5">
                Details <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            <div className="p-5 flex-1 flex flex-col justify-between">
              <div className="flex items-baseline justify-between mb-4">
                <span className="text-xs text-muted">Last 30 Days Spend</span>
                <span className="text-3xl font-extrabold tracking-tight text-fg">
                  {llm ? fmtCost(llm.totalCostUsd) : "$0.00"}
                </span>
              </div>
              <div className="space-y-2 border-t border-line/20 pt-4 flex-1">
                <span className="text-[11px] uppercase tracking-wider text-muted block mb-2">Cost By Model</span>
                {llm?.rows
                  .slice(0, 3)
                  .sort((a, b) => b.costEstUsd - a.costEstUsd)
                  .map((row, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="font-mono text-muted truncate max-w-[180px]" title={row.model ?? "Unknown"}>
                        {row.model ?? "Unknown"}
                      </span>
                      <span className="font-semibold text-fg">{fmtCost(row.costEstUsd)}</span>
                    </div>
                  ))}
              </div>
            </div>
          </Card>

          {/* ── 3. RAG Corpus Card ───────────────────────────────────────────── */}
          <Card className="flex flex-col h-full rounded-2xl overflow-hidden border-line/40">
            <div className="p-5 flex items-center justify-between border-b border-line/20">
              <div className="flex items-center gap-2.5">
                <Database className="h-4 w-4 text-accent" />
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">RAG Corpus</h2>
              </div>
              <Link href="/admin/rag-coverage" className="text-xs text-accent hover:underline flex items-center gap-0.5">
                Coverage <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            <div className="p-5 flex-1 space-y-4">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-surface-2/40 border border-line/20 rounded-xl p-2.5">
                  <div className="text-[11px] text-muted">Tickers</div>
                  <div className="text-lg font-bold mt-0.5 text-fg">{rag?.totalTickers ?? 0}</div>
                </div>
                <div className="bg-surface-2/40 border border-line/20 rounded-xl p-2.5">
                  <div className="text-[11px] text-muted">Chunks</div>
                  <div className="text-lg font-bold mt-0.5 text-fg">{rag?.totalChunks ?? 0}</div>
                </div>
                <div className="bg-surface-2/40 border border-line/20 rounded-xl p-2.5">
                  <div className="text-[11px] text-muted">Vectors</div>
                  <div className="text-lg font-bold mt-0.5 text-fg">{rag?.vectorStoreTotalVectors ?? 0}</div>
                </div>
              </div>

              {rag?.globalBreakdown && Object.keys(rag.globalBreakdown).length > 0 && (
                <div className="space-y-1.5 border-t border-line/20 pt-3">
                  <span className="text-[11px] uppercase tracking-wider text-muted block mb-1">Index Breakdown</span>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(rag.globalBreakdown)
                      .slice(0, 4)
                      .map(([src, count]) => (
                        <Chip key={src} tone={getSourceTone(src)} className="text-[10px] px-2 py-0.5 font-mono">
                          {count} {getSourceLabel(src)}
                        </Chip>
                      ))}
                  </div>
                </div>
              )}
            </div>
          </Card>

          {/* ── 4. Server & Infrastructure Card ──────────────────────────────── */}
          <Card className="flex flex-col h-full rounded-2xl overflow-hidden border-line/40">
            <div className="p-5 flex items-center justify-between border-b border-line/20">
              <div className="flex items-center gap-2.5">
                <Server className="h-4 w-4 text-accent" />
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Server & Infra</h2>
              </div>
              <Link href="/admin/server" className="text-xs text-accent hover:underline flex items-center gap-0.5">
                Infra <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            <div className="p-5 flex-1 space-y-4">
              <div className="space-y-3">
                {/* CPU Progress */}
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-muted flex items-center gap-1">
                      <Cpu className="h-3.5 w-3.5" /> CPU Load
                    </span>
                    <span className="font-semibold text-fg">{server?.resources.cpuPct.toFixed(1) ?? 0}%</span>
                  </div>
                  <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent transition-all duration-300"
                      style={{ width: `${server?.resources.cpuPct ?? 0}%` }}
                    />
                  </div>
                </div>

                {/* RAM Progress */}
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-muted">Memory (RAM)</span>
                    <span className="font-semibold text-fg">
                      {server?.resources.ramUsedGb.toFixed(1) ?? 0} / {server?.hostInfo.ramTotalGb.toFixed(0) ?? 0} GB
                    </span>
                  </div>
                  <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent transition-all duration-300"
                      style={{ width: `${((server?.resources.ramUsedGb ?? 0) / (server?.hostInfo.ramTotalGb ?? 1)) * 100}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Containers list */}
              <div className="border-t border-line/20 pt-3 flex items-center justify-between text-xs">
                <span className="text-muted">Docker Containers</span>
                <span className="font-mono text-fg font-semibold">
                  {server?.containers.filter((c) => c.state === "running").length ?? 0} Running
                </span>
              </div>
            </div>
          </Card>

          {/* ── 5. Chat Transcript Card (Full Width Span) ────────────────────── */}
          <Card className="flex flex-col sm:col-span-2 rounded-2xl overflow-hidden border-line/40">
            <div className="p-5 flex items-center justify-between border-b border-line/20">
              <div className="flex items-center gap-2.5">
                <FileText className="h-4 w-4 text-accent" />
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Latest Assistant Turns</h2>
              </div>
              <Link href="/admin/transcript" className="text-xs text-accent hover:underline flex items-center gap-0.5">
                Transcripts <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
            <div className="p-5 flex-1 divide-y divide-line/20">
              {transcript?.turns.filter((t) => t.role === "assistant").slice(0, 2).map((t, i) => (
                <div key={t.id} className={`${i > 0 ? "pt-3.5" : ""} pb-3.5 flex flex-col gap-1.5`}>
                  <div className="flex items-center justify-between text-xs">
                    <Chip tone="accent" className="font-mono text-[10px] px-2 py-0.5">
                      {t.model ?? "Unknown Model"}
                    </Chip>
                    <span className="text-[11px] text-faint font-mono">
                      {new Date(t.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-xs text-muted line-clamp-2 italic font-mono bg-surface-2/20 border border-line/10 p-2 rounded-xl">
                    {t.text}
                  </p>
                </div>
              ))}
              {transcript?.turns.filter((t) => t.role === "assistant").length === 0 && (
                <div className="text-center py-4 text-xs text-muted">No transcripts recorded yet.</div>
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
