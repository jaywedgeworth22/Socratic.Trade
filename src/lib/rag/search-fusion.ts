import { getDb } from "../db";
import { retrieveContextDetailed, getClients } from "../vector-db";
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

export async function retrieveFusedContext(
  query: string,
  symbol: string,
  limit: number = 5,
  userId: string = "local",
  options?: any
): Promise<FusionResult[]> {
  const db = getDb();

  // 1. Keyword search via SQLite FTS5 table document_chunks_fts
  const cleanKeywords = query
    .trim()
    .split(/\s+/)
    .map(w => `"${w.replace(/"/g, '""')}"`)
    .join(" OR ");

  let lexicalRows: any[] = [];
  try {
    lexicalRows = db.prepare(`
      SELECT content_hash, symbol, source, accession, text
      FROM document_chunks_fts
      WHERE symbol = ? AND text MATCH ?
      LIMIT 100
    `).all(symbol, cleanKeywords);
  } catch (err) {
    // Fallback if MATCH syntax fails or virtual table has issues
    lexicalRows = db.prepare(`
      SELECT content_hash, symbol, source, accession, text
      FROM document_chunks_fts
      WHERE symbol = ? AND text LIKE ?
      LIMIT 100
    `).all(symbol, `%${query}%`);
  }

  // 2. Vector search via retrieveContextDetailed
  let vectorResults: any[] = [];
  try {
    vectorResults = await retrieveContextDetailed(query, symbol, 100, userId, options);
  } catch (err) {
    console.warn("[search-fusion] Vector search failed (non-fatal):", err);
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

  // 3. Reciprocal Rank Fusion (RRF)
  const k = 60;
  const scoreMap = new Map<string, number>();
  const chunkDetails = new Map<string, { content_hash: string; accession: string; symbol: string; source: string; text: string }>();

  const addMatch = (contentHash: string, rank: number, details: any) => {
    const currentScore = scoreMap.get(contentHash) || 0;
    scoreMap.set(contentHash, currentScore + 1 / (k + rank));
    if (!chunkDetails.has(contentHash)) {
      chunkDetails.set(contentHash, details);
    }
  };

  lexicalRows.forEach((row, index) => {
    addMatch(row.content_hash, index + 1, {
      content_hash: row.content_hash,
      accession: row.accession,
      symbol: row.symbol,
      source: row.source,
      text: row.text
    });
  });

  vectorResults.forEach((r, index) => {
    const hashAndAcc = occurrenceMap.get(r.id) || { content_hash: getHash(r.text), accession: "" };
    addMatch(hashAndAcc.content_hash, index + 1, {
      content_hash: hashAndAcc.content_hash,
      accession: hashAndAcc.accession,
      symbol,
      source: r.source || "sec-edgar",
      text: r.text
    });
  });

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

  // Set chunk_id on each candidate and sort
  const candidates = rawCandidates.map(c => ({
    ...c,
    chunk_id: chunkIdMap.get(c.content_hash) || `${c.symbol}#c000` // Fallback if missing
  })).sort((a, b) => b.score - a.score);

  // 4. Maximal Marginal Relevance (MMR) cosine similarity filtering
  let voyageClient: any = null;
  try {
    const clients = await getClients(userId);
    voyageClient = clients.voyage;
  } catch (err) {
    // Ignore, fallback to text Jaccard similarity
  }

  const lambda = 0.5;
  const selected: FusionResult[] = [];
  const selectedIndices = new Set<number>();
  const m = Math.min(15, candidates.length);

  if (voyageClient) {
    try {
      // Fetch embeddings for query and top candidates
      const queryEmbed = await voyageClient.embed({
        model: "voyage-finance-2",
        input: [query],
        inputType: "query"
      });
      const queryVec = queryEmbed.data[0].embedding;

      const candTexts = candidates.slice(0, m).map(c => c.text);
      const candEmbeds = await voyageClient.embed({
        model: "voyage-finance-2",
        input: candTexts,
        inputType: "document"
      });
      const candVectors = candEmbeds.data.map((d: any) => d.embedding);

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
      console.warn("[search-fusion] Voyage embedding failed, falling back to Jaccard MMR:", embedErr);
    }
  }

  // Fallback Jaccard MMR Similarity
  while (selected.length < limit && selected.length < candidates.length) {
    let bestScore = -Infinity;
    let bestIndex = -1;

    for (let i = 0; i < m; i++) {
      if (selectedIndices.has(i)) continue;

      const relevance = candidates[i].score; // Use RRF score as relevance proxy
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
