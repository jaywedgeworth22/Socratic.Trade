// Durable two-phase vector commit and transcript-version receipts.

import { getDb } from "./db";

export type VectorCommitState = "pending" | "receipts_persisted" | "committed" | "aborted";

export interface BeginVectorCommitInput {
  id: string;
  tenantScope: string;
  userId: string;
  source: string;
  accession: string;
  contentVersion: string;
  parserRevision: string;
  embedRevision: string;
  expectedVectors: number;
  now?: string;
}

export interface ManagedChunkOccurrence {
  vectorId: string;
  contentHash: string;
  symbol: string;
  source: string;
  accession: string;
  sequence?: number;
  documentName?: string;
  section: string;
  ordinal: number;
  acceptedAt: string;
  tenantScope: string;
  contentVersion: string;
  commitId: string;
  receiptState: "pending" | "committed";
  createdAt: string;
}

export function insertManagedChunkOccurrences(occurrences: ManagedChunkOccurrence[]): void {
  if (occurrences.length === 0) return;
  const database = getDb();
  const insert = database.prepare(`
    INSERT OR IGNORE INTO chunk_occurrences (
      vector_id, content_hash, symbol, source, accession, sequence, document_name, section, ordinal,
      accepted_at, tenant_scope, content_version, commit_id, receipt_state, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  database.transaction(() => {
    for (const occurrence of occurrences) {
      insert.run(
        occurrence.vectorId,
        occurrence.contentHash,
        occurrence.symbol,
        occurrence.source,
        occurrence.accession,
        occurrence.sequence ?? null,
        occurrence.documentName ?? null,
        occurrence.section,
        occurrence.ordinal,
        occurrence.acceptedAt,
        occurrence.tenantScope,
        occurrence.contentVersion,
        occurrence.commitId,
        occurrence.receiptState,
        occurrence.createdAt
      );
    }
  })();
}

export function beginVectorCommit(input: BeginVectorCommitInput): void {
  const now = input.now ?? new Date().toISOString();
  const database = getDb();
  database.transaction(() => {
    database.prepare(`
      INSERT INTO vector_ingest_commits (
        id, tenant_scope, user_id, source, accession, content_version,
        parser_revision, embed_revision, expected_vectors, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        expected_vectors = excluded.expected_vectors,
        updated_at = excluded.updated_at,
        committed_at = NULL,
        state = 'pending'
    `).run(
      input.id,
      input.tenantScope,
      input.userId,
      input.source,
      input.accession,
      input.contentVersion,
      input.parserRevision,
      input.embedRevision,
      input.expectedVectors,
      now,
      now
    );
    // An idempotent replay deliberately returns the full managed set to pending before replacing
    // provider metadata. Retrieval fails closed until the replay reaches both commit boundaries.
    database.prepare(`
      UPDATE chunk_occurrences SET receipt_state = 'pending' WHERE commit_id = ?
    `).run(input.id);
  })();
}

export function markVectorCommitReceiptsPersisted(commitId: string, now = new Date().toISOString()): void {
  const result = getDb().prepare(`
    UPDATE vector_ingest_commits SET state = 'receipts_persisted', updated_at = ?
    WHERE id = ? AND state IN ('pending','receipts_persisted')
  `).run(now, commitId);
  if (result.changes !== 1) throw new Error("Vector commit receipt state was not persisted.");
}

export function markVectorCommitCommitted(commitId: string, now = new Date().toISOString()): void {
  const database = getDb();
  database.transaction(() => {
    const commit = database.prepare(`
      SELECT expected_vectors FROM vector_ingest_commits
      WHERE id = ? AND state IN ('receipts_persisted','committed')
    `).get(commitId) as { expected_vectors: number } | undefined;
    if (!commit) throw new Error("Vector commit has no durable receipt set.");
    const row = database.prepare(`
      SELECT COUNT(*) AS count FROM chunk_occurrences
      WHERE commit_id = ? AND receipt_state = 'pending'
    `).get(commitId) as { count: number };
    if (row.count !== commit.expected_vectors) throw new Error("Vector commit receipt cardinality mismatch.");
    database.prepare(`
      UPDATE chunk_occurrences SET receipt_state = 'committed'
      WHERE commit_id = ? AND receipt_state = 'pending'
    `).run(commitId);
    database.prepare(`
      UPDATE vector_ingest_commits
      SET state = 'committed', committed_at = COALESCE(committed_at, ?), updated_at = ?
      WHERE id = ?
    `).run(now, now, commitId);
  })();
}

export function abortVectorCommit(commitId: string, now = new Date().toISOString()): void {
  getDb().prepare(`
    UPDATE vector_ingest_commits SET state = 'aborted', updated_at = ?
    WHERE id = ? AND state <> 'committed'
  `).run(now, commitId);
}

export function committedManagedVectorReceipts(vectorIds: string[]): Map<string, {
  commitId: string;
  contentVersion: string;
  tenantScope: string;
  contentHash: string;
  symbol: string;
  source: string;
  accession: string;
  section: string;
  ordinal: number;
  parserRevision: string;
  embedRevision: string;
}> {
  const unique = [...new Set(vectorIds.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const placeholders = unique.map(() => "?").join(",");
  const rows = getDb().prepare(`
    SELECT o.vector_id, o.commit_id, o.content_version, o.tenant_scope,
           o.content_hash, o.symbol, o.source, o.accession, o.section, o.ordinal,
           c.parser_revision, c.embed_revision
    FROM chunk_occurrences o
    JOIN vector_ingest_commits c ON c.id = o.commit_id
    WHERE o.vector_id IN (${placeholders})
      AND o.receipt_state = 'committed' AND c.state = 'committed'
      AND o.tenant_scope = c.tenant_scope AND o.content_version = c.content_version
  `).all(...unique) as Array<{
    vector_id: string;
    commit_id: string;
    content_version: string;
    tenant_scope: string;
    content_hash: string;
    symbol: string;
    source: string;
    accession: string;
    section: string;
    ordinal: number;
    parser_revision: string;
    embed_revision: string;
  }>;
  return new Map(rows.map((row) => [row.vector_id, {
    commitId: row.commit_id,
    contentVersion: row.content_version,
    tenantScope: row.tenant_scope,
    contentHash: row.content_hash,
    symbol: row.symbol,
    source: row.source,
    accession: row.accession,
    section: row.section,
    ordinal: row.ordinal,
    parserRevision: row.parser_revision,
    embedRevision: row.embed_revision
  }]));
}

export interface PendingVectorCommit {
  id: string;
  state: VectorCommitState;
  source: string;
  accession: string;
  contentVersion: string;
  vectorIds: string[];
}

export function listPendingVectorCommits(limit = 100): PendingVectorCommit[] {
  const rows = getDb().prepare(`
    SELECT id, state, source, accession, content_version
    FROM vector_ingest_commits
    WHERE state IN ('pending','receipts_persisted','aborted')
    ORDER BY updated_at, id LIMIT ?
  `).all(Math.max(1, Math.min(1_000, Math.floor(limit)))) as Array<{
    id: string;
    state: VectorCommitState;
    source: string;
    accession: string;
    content_version: string;
  }>;
  const vectorRows = getDb().prepare(`
    SELECT vector_id FROM chunk_occurrences WHERE commit_id = ? ORDER BY vector_id
  `);
  return rows.map((row) => ({
    id: row.id,
    state: row.state,
    source: row.source,
    accession: row.accession,
    contentVersion: row.content_version,
    vectorIds: (vectorRows.all(row.id) as Array<{ vector_id: string }>).map((item) => item.vector_id)
  }));
}

export interface FmpTranscriptVersionRow {
  versionId: string;
  accession: string;
  contentSha256: string;
  symbol: string;
  year: number;
  quarter: number;
  callDate?: string;
  firstContentSeenAt: string;
  state: "observed" | "indexing" | "committed" | "failed";
  vectorCommitId?: string;
  chunkCount: number;
}

function mapVersion(row: Record<string, unknown>): FmpTranscriptVersionRow {
  return {
    versionId: String(row.version_id),
    accession: String(row.accession),
    contentSha256: String(row.content_sha256),
    symbol: String(row.symbol),
    year: Number(row.fiscal_year),
    quarter: Number(row.fiscal_quarter),
    ...(row.call_date ? { callDate: String(row.call_date) } : {}),
    firstContentSeenAt: String(row.first_content_seen_at),
    state: row.state as FmpTranscriptVersionRow["state"],
    ...(row.vector_commit_id ? { vectorCommitId: String(row.vector_commit_id) } : {}),
    chunkCount: Number(row.chunk_count)
  };
}

export function observeFmpTranscriptVersion(input: {
  versionId: string;
  accession: string;
  contentSha256: string;
  symbol: string;
  year: number;
  quarter: number;
  callDate?: string;
  observedAt: string;
}): FmpTranscriptVersionRow {
  const database = getDb();
  database.prepare(`
    INSERT INTO fmp_transcript_versions (
      version_id, accession, content_sha256, symbol, fiscal_year, fiscal_quarter,
      call_date, first_content_seen_at, state, observed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'observed', ?, ?)
    ON CONFLICT(accession, content_sha256) DO UPDATE SET
      call_date = COALESCE(excluded.call_date, fmp_transcript_versions.call_date),
      updated_at = excluded.updated_at
  `).run(
    input.versionId,
    input.accession,
    input.contentSha256,
    input.symbol,
    input.year,
    input.quarter,
    input.callDate ?? null,
    input.observedAt,
    input.observedAt,
    input.observedAt
  );
  const row = database.prepare(`
    SELECT * FROM fmp_transcript_versions WHERE accession = ? AND content_sha256 = ?
  `).get(input.accession, input.contentSha256) as Record<string, unknown>;
  return mapVersion(row);
}

export function setFmpTranscriptVersionState(
  versionId: string,
  state: FmpTranscriptVersionRow["state"],
  input: { vectorCommitId?: string; chunkCount?: number; at?: string } = {}
): void {
  const at = input.at ?? new Date().toISOString();
  getDb().prepare(`
    UPDATE fmp_transcript_versions
    SET state = ?, vector_commit_id = COALESCE(?, vector_commit_id),
        chunk_count = COALESCE(?, chunk_count),
        indexed_at = CASE WHEN ? = 'committed' THEN COALESCE(indexed_at, ?) ELSE indexed_at END,
        updated_at = ?
    WHERE version_id = ?
  `).run(state, input.vectorCommitId ?? null, input.chunkCount ?? null, state, at, at, versionId);
}

export function getFmpTranscriptVersion(accession: string, contentSha256: string): FmpTranscriptVersionRow | undefined {
  const row = getDb().prepare(`
    SELECT * FROM fmp_transcript_versions WHERE accession = ? AND content_sha256 = ?
  `).get(accession, contentSha256) as Record<string, unknown> | undefined;
  return row ? mapVersion(row) : undefined;
}
