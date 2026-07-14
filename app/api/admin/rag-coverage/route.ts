import { NextResponse } from "next/server";
import { getChunkCoverage, getChunkSourceBreakdown, getInternalSetting, listIngestedAccessions } from "@/lib/db";
import { getRagUsageSummary } from "@/lib/rag-metering";
import { getAllVectorStoreStats, getVectorStoreStats, type VectorIndexStats, type VectorStoreStats } from "@/lib/vector-db";
import { requireAdmin } from "@/lib/auth/admin";
import { getFmpTranscriptStatus } from "@/lib/web-sources/fmp-transcripts";

export const dynamic = "force-dynamic";

interface LastVectorIngest {
  at?: string;
  attempted?: number;
  indexed?: number;
  skipped?: boolean;
  error?: string;
  budgetSkipped?: number;
  writeUnitBudgetSkipped?: number;
  budget?: {
    requested?: number;
    allowed?: number;
    skipped?: number;
    usedLast24h?: number;
    limitPer24h?: number;
  };
  writeBudget?: {
    requestedEstimatedWriteUnits?: number;
    allowedEstimatedWriteUnits?: number;
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

  const [chunkCoverage, chunkBreakdown, ingested, vectorStats, allVectorIndexes, ragUsage] = await Promise.all([
    Promise.resolve(getChunkCoverage()),
    Promise.resolve(getChunkSourceBreakdown()),
    Promise.resolve(listIngestedAccessions(200)),
    getVectorStoreStats(),
    getAllVectorStoreStats(),
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

  // Compile breakdowns
  const globalBreakdown: Record<string, number> = {};
  const tickerBreakdown: Record<string, Record<string, number>> = {};
  for (const row of chunkBreakdown) {
    globalBreakdown[row.source] = (globalBreakdown[row.source] ?? 0) + row.chunkCount;
    if (!tickerBreakdown[row.symbol]) {
      tickerBreakdown[row.symbol] = {};
    }
    tickerBreakdown[row.symbol][row.source] = row.chunkCount;
  }

  const perTicker = [...new Set([...ingestedSymbols, ...chunkSymbols])]
    .map((symbol) => ({
      symbol,
      filings: filingCounts[symbol] ?? 0,
      chunks: chunkCoverage.find((c) => c.symbol === symbol)?.chunkCount ?? 0,
      latestChunkAt: chunkCoverage.find((c) => c.symbol === symbol)?.latestAt ?? null,
      breakdown: tickerBreakdown[symbol] ?? {}
    }))
    .sort((a, b) => b.chunks - a.chunks);

  const vectTotal = vectorStore?.totalVectorCount ?? 0;
  const allVectorTotal = (allVectorIndexes as VectorIndexStats[]).reduce((sum, row) => sum + (row.totalVectorCount ?? 0), 0);

  return NextResponse.json({
    sinceDays,
    perTicker,
    globalBreakdown,
    totalTickers: perTicker.length,
    totalChunks: perTicker.reduce((s, t) => s + t.chunks, 0),
    totalFilings: ingested.length,
    vectorStore,
    vectorStoreTotalVectors: vectTotal,
    allVectorIndexes,
    allVectorStoreTotalVectors: allVectorTotal,
    coverageGaps: noChunksSymbols,
    earningsTranscripts: getFmpTranscriptStatus(),
    providerUsage: {
      pinecone: {
        monthlyUsageApiAvailable: false,
        note: "Pinecone Database APIs expose per-request usage on operations and live index stats, but not an org-month Write Unit total through the app's normal SDK path. Cross-check provider quota in the Pinecone console; this page shows app-recorded units plus live index inventory.",
        configuredIndexVectors: vectTotal,
        allVisibleIndexVectors: allVectorTotal
      },
      voyage: {
        usageApiAvailable: false,
        note: "Voyage documents usage monitoring in its dashboard/Atlas UI. This page can show app-recorded embed/rerank estimates, but cannot reconstruct provider-account totals for calls made before local metering or outside this app."
      }
    },
    ragUsage: {
      sinceDays,
      totalCostUsd: ragUsage.reduce((s, r) => s + r.costEstUsd, 0),
      rows: ragUsage
    }
  });
}
