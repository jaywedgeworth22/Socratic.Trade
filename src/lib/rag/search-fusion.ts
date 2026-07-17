import { getDb, resolveApiKey } from "../db";
import { retrieveContextDetailed, getClients } from "../vector-db";
import { deconstructQuery } from "./query-deconstruct";
import { routeRetrievalIntent } from "./intent-router";
import crypto from "crypto";

export interface FusionResult {
  content_hash: string;
  chunk_id: string;
  symbol: string;
  source: string;
  accession: string;
  text: string;
  score: number;
}

function getHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function getJaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

async function fetchSiliconFlowEmbedding(texts: string[], userId: string = "local"): Promise<number[][]> {
  const apiKey = resolveApiKey("siliconflow", userId) || resolveApiKey("voyage", userId) || "";
  const response = await fetch("https://api.siliconflow.cn/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "BAAI/bge-m3",
      input: texts
    })
  });
  if (!response.ok) {
    throw new Error(`SiliconFlow Embedding failed in search fusion: ${response.status}`);
  }
  const res = await response.json();
  return res.data.map((d: any) => d.embedding);
}

export async function retrieveFusedContext(
  query: string,
  symbol: string,
  limit: number = 5,
  userId: string = "local",
  options?: any
): Promise<FusionResult[]> {
  const db = getDb();
  const asOf = options?.asOf || options?.acceptance_datetime || null;

  // 1. Query Deconstruction / Expansion
  const subQueries = await deconstructQuery(query, userId);
  const k = 60;
  const scoreMap = new Map<string, number>();
  const chunkDetails = new Map<string, { content_hash: string; accession: string; symbol: string; source: string; text: string }>();

  // Process each sub-query
  for (const subQuery of subQueries) {
    // 2. Intent Routing for this sub-query
    const intent = routeRetrievalIntent(subQuery);

    let lexicalRows: any[] = [];
    if (intent === "lexical" || intent === "hybrid") {
      const cleanKeywords = subQuery
        .trim()
        .split(/\s+/)
        .map(w => `"${w.replace(/"/g, '""')}"`)
        .join(" OR ");

      try {
        if (asOf) {
          lexicalRows = db.prepare(`
            SELECT DISTINCT f.content_hash, f.symbol, f.source, o.accession, f.text
            FROM document_chunks_fts f
            JOIN chunk_occurrences o ON f.content_hash = o.content_hash
            WHERE f.symbol = ? AND f.text MATCH ? AND o.accepted_at <= ?
            LIMIT 100
          `).all(symbol, cleanKeywords, String(asOf));
        } else {
          lexicalRows = db.prepare(`
            SELECT content_hash, symbol, source, accession, text
            FROM document_chunks_fts
            WHERE symbol = ? AND text MATCH ?
            LIMIT 100
          `).all(symbol, cleanKeywords);
        }
      } catch (err) {
        try {
          if (asOf) {
            lexicalRows = db.prepare(`
              SELECT DISTINCT f.content_hash, f.symbol, f.source, o.accession, f.text
              FROM document_chunks_fts f
              JOIN chunk_occurrences o ON f.content_hash = o.content_hash
              WHERE f.symbol = ? AND f.text LIKE ? AND o.accepted_at <= ?
              LIMIT 100
            `).all(symbol, `%${subQuery}%`, String(asOf));
          } else {
            lexicalRows = db.prepare(`
              SELECT content_hash, symbol, source, accession, text
              FROM document_chunks_fts
              WHERE symbol = ? AND text LIKE ?
              LIMIT 100
            `).all(symbol, `%${subQuery}%`);
          }
        } catch (innerErr) {
          // ignore
        }
      }
    }

    let vectorResults: any[] = [];
    if (intent === "semantic" || intent === "hybrid") {
      try {
        vectorResults = await retrieveContextDetailed(subQuery, symbol, 100, userId, options);
      } catch (err) {
        console.warn("[search-fusion] Vector search failed (non-fatal):", err);
      }
    }

    // Resolve content hash and accession for vector matches
    const vectorIds = vectorResults.map(r => r.id);
    const occurrenceMap = new Map<string, { content_hash: string; accession: string }>();

    if (vectorIds.length > 0) {
      const placeholders = vectorIds.map(() => "?").join(",");
      const occurrences = db.prepare(`
        SELECT vector_id, content_hash, accession
        FROM chunk_occurrences
        WHERE vector_id IN (${placeholders})
      `).all(...vectorIds) as any[];

      for (const o of occurrences) {
        occurrenceMap.set(o.vector_id, { content_hash: o.content_hash, accession: o.accession });
      }
    }

    // Accumulate RRF scores for lexical match rankings
    lexicalRows.forEach((row, index) => {
      const currentScore = scoreMap.get(row.content_hash) || 0;
      scoreMap.set(row.content_hash, currentScore + 1 / (k + index + 1));
      if (!chunkDetails.has(row.content_hash)) {
        chunkDetails.set(row.content_hash, {
          content_hash: row.content_hash,
          accession: row.accession,
          symbol: row.symbol,
          source: row.source,
          text: row.text
        });
      }
    });

    // Accumulate RRF scores for vector match rankings
    vectorResults.forEach((r, index) => {
      const hashAndAcc = occurrenceMap.get(r.id) || { content_hash: getHash(r.text), accession: "" };
      const currentScore = scoreMap.get(hashAndAcc.content_hash) || 0;
      scoreMap.set(hashAndAcc.content_hash, currentScore + 1 / (k + index + 1));
      if (!chunkDetails.has(hashAndAcc.content_hash)) {
        chunkDetails.set(hashAndAcc.content_hash, {
          content_hash: hashAndAcc.content_hash,
          accession: hashAndAcc.accession,
          symbol,
          source: r.source || "sec-edgar",
          text: r.text
        });
      }
    });
  }

  const rawCandidates = Array.from(scoreMap.entries())
    .map(([hash, score]) => ({
      ...chunkDetails.get(hash)!,
      score
    }));

  if (rawCandidates.length === 0) return [];

  // Batch query to resolve chunk_ids for all unique content_hashes in rawCandidates
  const hashes = rawCandidates.map(c => c.content_hash);
  const placeholders = hashes.map(() => "?").join(",");
  const chunkRows = db.prepare(`
    SELECT content_hash, chunk_id
    FROM document_chunks
    WHERE content_hash IN (${placeholders})
  `).all(...hashes) as any[];

  const chunkIdMap = new Map<string, string>();
  for (const row of chunkRows) {
    chunkIdMap.set(row.content_hash, row.chunk_id);
  }

  // 3. Self-Measurement Feedback Loop (Retrieve stats and boost wins)
  const accessions = Array.from(new Set(rawCandidates.map(c => c.accession).filter(Boolean)));
  const boostMap = new Map<string, number>();

  if (accessions.length > 0) {
    try {
      const accPlaceholders = accessions.map(() => "?").join(",");
      const stats = db.prepare(`
        SELECT doc_id, SUM(wins) as wins, SUM(losses) as losses
        FROM retrieval_usefulness_stats
        WHERE user_id = ? AND doc_id IN (${accPlaceholders})
        GROUP BY doc_id
      `).all(userId, ...accessions) as any[];

      for (const row of stats) {
        const wins = Number(row.wins || 0);
        const losses = Number(row.losses || 0);
        const total = wins + losses;
        if (total > 0) {
          const winRatio = wins / total;
          // Apply a nudge boost up to +30% for high win documents
          boostMap.set(row.doc_id, 1.0 + winRatio * 0.3);
        }
      }
    } catch (err) {
      // stats table might not be populated or fail silently
    }
  }

  // Set chunk_id on each candidate, apply usefulness boost, and sort
  const candidates = rawCandidates.map(c => {
    const boost = boostMap.get(c.accession) || 1.0;
    return {
      ...c,
      chunk_id: chunkIdMap.get(c.content_hash) || `${c.symbol}#c000`, // Fallback if missing
      score: c.score * boost
    };
  }).sort((a, b) => b.score - a.score);

  // 4. Maximal Marginal Relevance (MMR) cosine similarity filtering
  const lambda = 0.5;
  const selected: FusionResult[] = [];
  const selectedIndices = new Set<number>();
  const m = Math.min(Math.max(limit, 15), candidates.length);

  try {
    const queryVecs = await fetchSiliconFlowEmbedding([query], userId);
    const queryVec = queryVecs[0];
    const candTexts = candidates.slice(0, m).map(c => c.text);
    const candVectors = await fetchSiliconFlowEmbedding(candTexts, userId);

    const cosineSim = (a: number[], b: number[]) => {
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }
      return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
    };

    while (selected.length < limit && selected.length < candidates.length) {
      let bestScore = -Infinity;
      let bestIndex = -1;

      for (let i = 0; i < m; i++) {
        if (selectedIndices.has(i)) continue;

        const relevance = cosineSim(candVectors[i], queryVec);
        let maxSimilarity = 0;

        for (const selIdx of selectedIndices) {
          const sim = cosineSim(candVectors[i], candVectors[selIdx]);
          if (sim > maxSimilarity) {
            maxSimilarity = sim;
          }
        }

        const score = lambda * relevance - (1 - lambda) * maxSimilarity;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      if (bestIndex === -1) break;
      selectedIndices.add(bestIndex);
      selected.push(candidates[bestIndex]);
    }

    return selected;
  } catch (embedErr) {
    // Fallback Jaccard MMR Similarity
    while (selected.length < limit && selected.length < candidates.length) {
      let bestScore = -Infinity;
      let bestIndex = -1;

      for (let i = 0; i < m; i++) {
        if (selectedIndices.has(i)) continue;

        const relevance = candidates[i].score; // Use boosted RRF score as relevance proxy
        let maxSimilarity = 0;

        for (const selIdx of selectedIndices) {
          const sim = getJaccardSimilarity(candidates[i].text, candidates[selIdx].text);
          if (sim > maxSimilarity) {
            maxSimilarity = sim;
          }
        }

        const score = lambda * relevance - (1 - lambda) * maxSimilarity;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      if (bestIndex === -1) break;
      selectedIndices.add(bestIndex);
      selected.push(candidates[bestIndex]);
    }

    return selected;
  }
}
