// Disclosure RAG embedding — congressional trades + insider filings.
//
// Converts structured disclosure records into natural-language RAG documents and
// upserts them into the shared vector store. Gated by RAG_EMBED_DISCLOSURES (default
// off) so the structured storage pipeline is completely unaffected when the flag is
// absent or set to "off".
//
// Pattern mirrors sec8k.ts: fire-and-forget, best-effort, never throws into callers.
// vector-db is loaded via dynamic import so the heavy embedding stack (Voyage/Pinecone)
// is only pulled in when the flag is on and there is data to embed.

import type { CongressTrade } from "./types";
import type { InsiderFiling } from "./sec";
import type { ContextDocument } from "../vector-db";
import { envFlagOn } from "../rag/env-flag";

// ── Flag ─────────────────────────────────────────────────────────────────────

/**
 * Returns true when RAG_EMBED_DISCLOSURES is set to a truthy value. Default is off.
 *
 * R6 (2026-07-01 RAG backlog): previously required the EXACT string "on" — `RAG_EMBED_DISCLOSURES=true`
 * silently no-op'd even though every other RAG flag in this app accepts "true"/"1"/"yes". Now routed
 * through the shared `envFlagOn` parser so "true"/"1"/"yes"/"on" are all accepted. This is an
 * intentional, SAFE-DIRECTION behavior change: an operator who set any of those "look-alike" values
 * was already trying to turn disclosure embedding ON. Note it triggers real Voyage/Pinecone embedding
 * cost/corpus growth for any operator who was unknowingly relying on the old exact-match quirk to
 * silently no-op with e.g. `=true`.
 */
export function disclosureRagEnabled(): boolean {
  try {
    // Settings override then env (source-settings).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolveSourceBool } = require("../source-settings") as typeof import("../source-settings");
    return resolveSourceBool("RAG_EMBED_DISCLOSURES");
  } catch {
    return envFlagOn("RAG_EMBED_DISCLOSURES", false);
  }
}

// ── Text builders ────────────────────────────────────────────────────────────

function formatAmount(low?: number, high?: number): string {
  if (low == null && high == null) return "";
  if (low != null && high != null) {
    return `Amount range: $${low.toLocaleString()}–$${high.toLocaleString()} USD. `;
  }
  if (low != null) return `Amount range: at least $${low.toLocaleString()} USD. `;
  return `Amount range: up to $${high!.toLocaleString()} USD. `;
}

function tradeToDoc(trade: CongressTrade): ContextDocument {
  const amount = formatAmount(trade.amountLow, trade.amountHigh);
  const disclosed = trade.disclosedAt ? `Disclosed: ${trade.disclosedAt}. ` : "";
  const text =
    `${trade.member} (${trade.chamber}) disclosed a ${trade.side.toUpperCase()} of ${trade.symbol}. ` +
    `${amount}` +
    `Trade date: ${trade.tradedAt}. ` +
    `${disclosed}` +
    `Source: ${trade.source}.`;

  const acceptanceDatetime = trade.disclosedAt ?? trade.tradedAt;

  return {
    text,
    metadata: {
      symbol: trade.symbol,
      source: "congress-disclosure",
      timestamp: acceptanceDatetime,
      accession: `${trade.symbol}|${trade.member}|${trade.side}|${trade.tradedAt}`,
      doc_type: "congress-trade",
      acceptance_datetime: acceptanceDatetime
    }
  };
}

function filingToDoc(filing: InsiderFiling): ContextDocument {
  const text =
    `Insider filing for ${filing.symbol} by ${filing.owner}. ` +
    `Open-market purchases: ${filing.buyTx} transaction(s) (${filing.buyShares} shares). ` +
    `Open-market sales: ${filing.sellTx} transaction(s) (${filing.sellShares} shares). ` +
    `Filed: ${filing.filedAt}. Accession: ${filing.accession}.`;

  return {
    text,
    metadata: {
      symbol: filing.symbol,
      source: "insider-filing",
      timestamp: filing.filedAt,
      accession: filing.accession,
      doc_type: "insider-filing",
      acceptance_datetime: filing.filedAt
    }
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface EmbedDisclosuresResult {
  attempted: number;
  indexed: number;
  skipped?: boolean;
  error?: string;
}

/**
 * Convert congress trades + insider filings into RAG documents and upsert them
 * into the vector store. Returns immediately (skipped: true) when the flag is off.
 * Never throws — always returns a result object or logs and returns an error string.
 */
export async function embedDisclosures(
  trades: CongressTrade[],
  filings: InsiderFiling[],
  userId = "local"
): Promise<EmbedDisclosuresResult> {
  if (!disclosureRagEnabled()) {
    return { attempted: 0, indexed: 0, skipped: true };
  }

  const docs: ContextDocument[] = [
    ...trades.map(tradeToDoc),
    ...filings.map(filingToDoc)
  ];

  if (docs.length === 0) {
    return { attempted: 0, indexed: 0 };
  }

  try {
    const { storeContexts } = await import("../vector-db");
    // R10 (2026-07-01 RAG backlog): content_hash dedup, gated on the same
    // VECTOR_STORECONTEXTS_DEDUP flag as the 8-K summary path — a disclosure batch commonly
    // re-embeds the same congress-trade/insider-filing text across refresh cycles.
    const result = await storeContexts(
      docs,
      userId,
      envFlagOn("VECTOR_STORECONTEXTS_DEDUP", true) ? { dedupKeyPrefix: "disclosure" } : undefined
    );

    // Best-effort audit — never let audit failures propagate
    import("../db")
      .then(({ audit }) =>
        audit("disclosure_rag_embed", {
          ok: !result.error,
          attempted: result.attempted,
          indexed: result.indexed,
          skipped: result.skipped
        })
      )
      .catch(() => {});

    return {
      attempted: result.attempted,
      indexed: result.indexed,
      skipped: result.skipped,
      error: result.error
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[disclosure-rag] embed failed:", msg);
    return { attempted: docs.length, indexed: 0, error: msg };
  }
}
