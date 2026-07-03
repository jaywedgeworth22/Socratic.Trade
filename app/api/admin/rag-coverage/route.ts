import { NextResponse } from "next/server";
import { getChunkCoverage, getInternalSetting, listIngestedAccessions } from "@/lib/db";
import { getRagUsageSummary } from "@/lib/rag-metering";
import { getVectorStoreStats, type VectorStoreStats } from "@/lib/vector-db";
import { requireAdmin } from "@/lib/auth/admin";

export const dynamic = "force-dynamic";

interface LastVectorIngest {
  at?: string;
  attempted?: number;
  indexed?: number;
  skipped?: boolean;
  error?: string;
  budgetSkipped?: number;
  budget?: {
    requested?: number;
    allowed?: number;
    skipped?: number;
    usedLast24h?: number;
    limitPer24h?: number;
  };
}

type VectorStoreAdminStats = VectorStoreStats & {
  lastIngest?: LastVectorIngest;
};

// Admin/diagnostic route: corpus coverage stats — what's in the RAG index per ticker,
// how fresh it is, and which tickers have no filings at all.
//
// GET  /api/admin/rag-coverage                       → full report
// GET  /api/admin/rag-coverage?sinceDays=7             → rag usage window
export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const sinceDays = Number(url.searchParams.get("sinceDays")) || 30;
  const sinceIso = new Date(Date.now() - sinceDays * 24 * 60 * 60_000).toISOString();

  const [chunkCoverage, ingested, vectorStats, ragUsage] = await Promise.all([
    Promise.resolve(getChunkCoverage()),
    Promise.resolve(listIngestedAccessions(200)),
    getVectorStoreStats(),
    Promise.resolve(getRagUsageSummary({ sinceIso }))
  ]);
  const vectorStore: VectorStoreAdminStats = {
    ...vectorStats,
    lastIngest: getInternalSetting<LastVectorIngest>("vectorStore:lastIngest")
  };

  // Coverage gaps: symbols in ingested_accessions that have NO document_chunks.
  const ingestedSymbols = new Set(ingested.map((r) => r.ticker));
  const chunkSymbols = new Set(chunkCoverage.map((r) => r.symbol));
  const noChunksSymbols = [...ingestedSymbols].filter((s) => !chunkSymbols.has(s));

  const filingCounts: Record<string, number> = {};
  for (const r of ingested) {
    filingCounts[r.ticker] = (filingCounts[r.ticker] ?? 0) + 1;
  }

  const perTicker = [...new Set([...ingestedSymbols, ...chunkSymbols])]
    .map((symbol) => ({
      symbol,
      filings: filingCounts[symbol] ?? 0,
      chunks: chunkCoverage.find((c) => c.symbol === symbol)?.chunkCount ?? 0,
      latestChunkAt: chunkCoverage.find((c) => c.symbol === symbol)?.latestAt ?? null
    }))
    .sort((a, b) => b.chunks - a.chunks);

  const vectTotal = vectorStore?.totalVectorCount ?? 0;

  return NextResponse.json({
    sinceDays,
    perTicker,
    totalTickers: perTicker.length,
    totalChunks: perTicker.reduce((s, t) => s + t.chunks, 0),
    totalFilings: ingested.length,
    vectorStore,
    vectorStoreTotalVectors: vectTotal,
    coverageGaps: noChunksSymbols,
    ragUsage: {
      sinceDays,
      totalCostUsd: ragUsage.reduce((s, r) => s + r.costEstUsd, 0),
      rows: ragUsage
    }
  });
}
