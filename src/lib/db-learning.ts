// db-learning.ts — audit-event helpers, counterfactual learning watermarks/candidates,
// learned-context fact-tier functions, reflection version history, and RAG ingestion
// (ingested_accessions).
import { randomUUID } from "crypto";
import { getDb } from "./db";
import type { LearnedContextRow, LearnedContextPendingRow, LearnedContextPendingStatus } from "./types";

// ── Audit-event helpers ────────────────────────────────────────────────────────

export function listAudit(
  limit = 100,
  userId: string = "local",
  connectedAccountId?: string,
  includeUserWide = false
): Array<{ id: string; createdAt: string; kind: string; payload: unknown; connectedAccountId?: string }> {
  const rows = (connectedAccountId
    ? getDb()
      .prepare(
        `SELECT id, connected_account_id, created_at, kind, payload
         FROM audit_events
         WHERE user_id = ? AND (connected_account_id = ?${includeUserWide ? " OR connected_account_id IS NULL" : ""})
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(userId, connectedAccountId, limit)
    : getDb()
      .prepare("SELECT id, connected_account_id, created_at, kind, payload FROM audit_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(userId, limit)) as Array<{ id: string; connected_account_id: string | null; created_at: string; kind: string; payload: string }>;
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    connectedAccountId: row.connected_account_id ?? undefined
  }));
}

export function latestAuditByKind(
  kind: string,
  userId: string = "local",
  connectedAccountId?: string
): { id: string; createdAt: string; kind: string; payload: unknown; connectedAccountId?: string } | undefined {
  const row = (connectedAccountId
    ? getDb()
      .prepare("SELECT id, connected_account_id, created_at, kind, payload FROM audit_events WHERE kind = ? AND user_id = ? AND connected_account_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(kind, userId, connectedAccountId)
    : getDb()
      .prepare("SELECT id, connected_account_id, created_at, kind, payload FROM audit_events WHERE kind = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(kind, userId)) as { id: string; connected_account_id: string | null; created_at: string; kind: string; payload: string } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    createdAt: row.created_at,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    connectedAccountId: row.connected_account_id ?? undefined
  };
}

export interface SignalSnapshotAuditRow {
  rowid: number;
  id: string;
  createdAt: string;
  payload: unknown;
}

export function listSignalSnapshotAuditAfter(
  userId: string = "local",
  watermark?: { lastAuditRowid?: number },
  limit = 100,
  connectedAccountId?: string
): SignalSnapshotAuditRow[] {
  const hasWatermark = typeof watermark?.lastAuditRowid === "number";
  // Per-account scoping: when an account id is given, only that account's snapshots count toward
  // its learning. rowid is globally monotonic, so `rowid > lastAuditRowid AND account = ?` advances
  // each account's watermark over its own rows independently.
  const accountClause = connectedAccountId ? " AND connected_account_id = ?" : "";
  const rows = hasWatermark
    ? (getDb()
        .prepare(
          `SELECT rowid, id, created_at, payload
           FROM audit_events
           WHERE user_id = ?
            AND kind = 'signal_snapshot'
            AND rowid > ?${accountClause}
           ORDER BY rowid ASC
           LIMIT ?`
        )
        .all(...(connectedAccountId
          ? [userId, watermark!.lastAuditRowid, connectedAccountId, limit]
          : [userId, watermark!.lastAuditRowid, limit])) as Array<{ rowid: number; id: string; created_at: string; payload: string }>)
    : (getDb()
        .prepare(
          `SELECT rowid, id, created_at, payload
           FROM audit_events
           WHERE user_id = ? AND kind = 'signal_snapshot'${accountClause}
           ORDER BY rowid ASC
           LIMIT ?`
        )
        .all(...(connectedAccountId ? [userId, connectedAccountId, limit] : [userId, limit])) as Array<{ rowid: number; id: string; created_at: string; payload: string }>);

  return rows.map((row) => ({ rowid: row.rowid, id: row.id, createdAt: row.created_at, payload: JSON.parse(row.payload) }));
}

// ── Counterfactual learning watermarks ────────────────────────────────────────

export interface CounterfactualLearningWatermark {
  userId: string;
  lastAuditRowid?: number;
  lastAuditCreatedAt?: string;
  lastAuditId?: string;
  updatedAt: string;
}

// Per-account watermarks: the table's PK is (user_id, connected_account_id). The account-agnostic
// (user-wide) watermark is stored with connected_account_id = '' (empty string, never NULL) so the
// composite PK stays well-defined — SQLite would treat multiple NULLs as distinct, breaking upserts.
export function getCounterfactualLearningWatermark(
  userId: string = "local",
  connectedAccountId?: string
): CounterfactualLearningWatermark | undefined {
  const row = getDb()
    .prepare("SELECT user_id, last_audit_rowid, last_audit_created_at, last_audit_id, updated_at FROM counterfactual_learning_watermarks WHERE user_id = ? AND connected_account_id = ?")
    .get(userId, connectedAccountId ?? "") as { user_id: string; last_audit_rowid: number | null; last_audit_created_at: string | null; last_audit_id: string | null; updated_at: string } | undefined;
  if (!row) return undefined;
  return {
    userId: row.user_id,
    lastAuditRowid: row.last_audit_rowid ?? undefined,
    lastAuditCreatedAt: row.last_audit_created_at ?? undefined,
    lastAuditId: row.last_audit_id ?? undefined,
    updatedAt: row.updated_at
  };
}

export function setCounterfactualLearningWatermark(input: {
  userId?: string;
  connectedAccountId?: string;
  lastAuditRowid?: number;
  lastAuditCreatedAt?: string;
  lastAuditId?: string;
  updatedAt?: string;
}): void {
  const userId = input.userId ?? "local";
  const connectedAccountId = input.connectedAccountId ?? "";
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO counterfactual_learning_watermarks (user_id, connected_account_id, last_audit_rowid, last_audit_created_at, last_audit_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, connected_account_id) DO UPDATE SET
        last_audit_rowid = excluded.last_audit_rowid,
        last_audit_created_at = excluded.last_audit_created_at,
        last_audit_id = excluded.last_audit_id,
        updated_at = excluded.updated_at`
    )
    .run(userId, connectedAccountId, input.lastAuditRowid ?? null, input.lastAuditCreatedAt ?? null, input.lastAuditId ?? null, updatedAt);
}

// ── Skipped-candidate counterfactuals ─────────────────────────────────────────

export interface SkippedCounterfactualCandidateInput {
  userId?: string;
  connectedAccountId?: string;
  runId: string;
  symbol: string;
  snapshotAt: string;
  refPrice: number;
  horizonDays: number;
  targetDate: string;
  score?: number;
  sector?: string;
  regime?: string;
  dominantFactor?: string;
  bulletins?: string[];
  now?: string;
}

export interface SkippedCounterfactualRow {
  id: string;
  userId: string;
  runId: string;
  symbol: string;
  snapshotAt: string;
  refPrice: number;
  horizonDays: number;
  targetDate: string;
  status: "pending" | "matured";
  exitDate?: string;
  exitPrice?: number;
  returnPct?: number;
  score?: number;
  sector?: string;
  regime?: string;
  dominantFactor?: string;
  bulletins?: string[];
  lastCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
}

type RawSkippedCounterfactualRow = {
  id: string;
  user_id: string;
  run_id: string;
  symbol: string;
  snapshot_at: string;
  ref_price: number;
  horizon_days: number;
  target_date: string;
  status: string;
  exit_date: string | null;
  exit_price: number | null;
  return_pct: number | null;
  score: number | null;
  sector: string | null;
  regime: string | null;
  dominant_factor: string | null;
  bulletins: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

function toSkippedCounterfactualRow(row: RawSkippedCounterfactualRow): SkippedCounterfactualRow {
  return {
    id: row.id,
    userId: row.user_id,
    runId: row.run_id,
    symbol: row.symbol,
    snapshotAt: row.snapshot_at,
    refPrice: row.ref_price,
    horizonDays: row.horizon_days,
    targetDate: row.target_date,
    status: row.status === "matured" ? "matured" : "pending",
    exitDate: row.exit_date ?? undefined,
    exitPrice: row.exit_price ?? undefined,
    returnPct: row.return_pct ?? undefined,
    score: row.score ?? undefined,
    sector: row.sector ?? undefined,
    regime: row.regime ?? undefined,
    dominantFactor: row.dominant_factor ?? undefined,
    bulletins: row.bulletins ? JSON.parse(row.bulletins) as string[] : undefined,
    lastCheckedAt: row.last_checked_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function insertSkippedCounterfactualCandidate(input: SkippedCounterfactualCandidateInput): boolean {
  const userId = input.userId ?? "local";
  const now = input.now ?? new Date().toISOString();
  const id = `${userId}:${input.runId}:${input.symbol}:${input.horizonDays}`;
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO skipped_candidate_counterfactuals (
        id, user_id, connected_account_id, run_id, symbol, snapshot_at, ref_price, horizon_days,
        target_date, status, score, sector, regime, dominant_factor, bulletins,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      userId,
      input.connectedAccountId ?? null,
      input.runId,
      input.symbol,
      input.snapshotAt,
      input.refPrice,
      input.horizonDays,
      input.targetDate,
      input.score ?? null,
      input.sector ?? null,
      input.regime ?? null,
      input.dominantFactor ?? null,
      input.bulletins ? JSON.stringify(input.bulletins) : null,
      now,
      now
    );
  return result.changes > 0;
}

export function listPendingSkippedCounterfactuals(input: {
  userId?: string;
  nowDate: string;
  checkedBefore?: string;
  limit?: number;
}): SkippedCounterfactualRow[] {
  const userId = input.userId ?? "local";
  const limit = input.limit ?? 50;
  const rows = getDb()
    .prepare(
      `SELECT *
       FROM skipped_candidate_counterfactuals
       WHERE user_id = ?
        AND status = 'pending'
        AND target_date <= ?
        AND (last_checked_at IS NULL OR last_checked_at <= ?)
       ORDER BY target_date ASC, snapshot_at ASC, symbol ASC
       LIMIT ?`
    )
    .all(userId, input.nowDate, input.checkedBefore ?? new Date(0).toISOString(), limit) as RawSkippedCounterfactualRow[];
  return rows.map(toSkippedCounterfactualRow);
}

export function markSkippedCounterfactualChecked(id: string, userId: string = "local", checkedAt: string = new Date().toISOString()): void {
  getDb()
    .prepare("UPDATE skipped_candidate_counterfactuals SET last_checked_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'")
    .run(checkedAt, checkedAt, id, userId);
}

export function markSkippedCounterfactualMatured(input: {
  id: string;
  userId?: string;
  exitDate: string;
  exitPrice: number;
  returnPct: number;
  checkedAt?: string;
}): boolean {
  const userId = input.userId ?? "local";
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE skipped_candidate_counterfactuals
       SET status = 'matured',
        exit_date = ?,
        exit_price = ?,
        return_pct = ?,
        last_checked_at = ?,
        updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'pending'`
    )
    .run(input.exitDate, input.exitPrice, input.returnPct, checkedAt, checkedAt, input.id, userId);
  return result.changes > 0;
}

export function listMaturedSkippedCounterfactuals(
  userId: string = "local",
  limit = 50,
  connectedAccountId?: string
): SkippedCounterfactualRow[] {
  const rows = (connectedAccountId
    ? getDb()
        .prepare(
          `SELECT *
           FROM skipped_candidate_counterfactuals
           WHERE user_id = ? AND status = 'matured' AND connected_account_id = ?
           ORDER BY return_pct DESC, updated_at DESC
           LIMIT ?`
        )
        .all(userId, connectedAccountId, limit)
    : getDb()
        .prepare(
          `SELECT *
           FROM skipped_candidate_counterfactuals
           WHERE user_id = ? AND status = 'matured'
           ORDER BY return_pct DESC, updated_at DESC
           LIMIT ?`
        )
        .all(userId, limit)) as RawSkippedCounterfactualRow[];
  return rows.map(toSkippedCounterfactualRow);
}

// ── Learned-context fact-tier CRUD ────────────────────────────────────────────

interface RawLearnedContextRow {
  id: string;
  user_id: string;
  scope: string;
  kind: string;
  subject: string;
  symbol: string | null;
  value: string;
  source: string;
  origin: string;
  risk_tier: string;
  confidence: number;
  contributor_user_id: string | null;
  asserted_at: string;
  superseded_by: string | null;
  expires_at: string | null;
  regime: string | null;
  thesis_tag: string | null;
  dominant_factor: string | null;
}

export function mapLearnedContext(row: RawLearnedContextRow): LearnedContextRow {
  return {
    id: row.id,
    userId: row.user_id,
    scope: row.scope as LearnedContextRow["scope"],
    kind: row.kind as LearnedContextRow["kind"],
    subject: row.subject,
    symbol: row.symbol,
    value: row.value,
    source: row.source,
    origin: row.origin as LearnedContextRow["origin"],
    riskTier: row.risk_tier as LearnedContextRow["riskTier"],
    confidence: row.confidence,
    contributorUserId: row.contributor_user_id,
    assertedAt: row.asserted_at,
    supersededBy: row.superseded_by,
    expiresAt: row.expires_at,
    regime: row.regime ?? null,
    thesisTag: row.thesis_tag ?? null,
    dominantFactor: row.dominant_factor ?? null
  };
}

export function insertLearnedContext(row: LearnedContextRow): LearnedContextRow {
  getDb()
    .prepare(
      `INSERT INTO learned_context
        (id, user_id, scope, kind, subject, symbol, value, source, origin, risk_tier, confidence, contributor_user_id, asserted_at, superseded_by, expires_at, regime, thesis_tag, dominant_factor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.userId,
      row.scope,
      row.kind,
      row.subject,
      row.symbol,
      row.value,
      row.source,
      row.origin,
      row.riskTier,
      row.confidence,
      row.contributorUserId,
      row.assertedAt,
      row.supersededBy,
      row.expiresAt,
      row.regime ?? null,
      row.thesisTag ?? null,
      row.dominantFactor ?? null
    );
  return row;
}

export function findLiveLearnedContextBySubject(
  userId: string,
  kind: string,
  subject: string,
  symbol: string | null
): LearnedContextRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM learned_context
       WHERE user_id = ? AND kind = ? AND subject = ? AND ((symbol IS NULL AND ? IS NULL) OR symbol = ?)
         AND superseded_by IS NULL
       ORDER BY asserted_at DESC LIMIT 1`
    )
    .get(userId, kind, subject, symbol, symbol) as RawLearnedContextRow | undefined;
  return row ? mapLearnedContext(row) : null;
}

/**
 * Live FACT rows for a decision: the user's own private rows plus, when includeShared is set,
 * other contributors' opted-in shared rows. Filtered to the given symbols (plus symbol-less
 * rows, which are general facts) and to non-expired rows. READ-ONLY — never mutates.
 */
export function listLearnedContextForDecision(
  userId: string,
  symbols: string[],
  includeShared = false
): LearnedContextRow[] {
  const nowIso = new Date().toISOString();
  const normalizedSymbols = new Set(symbols.map((s) => s.toUpperCase()));
  const rows = includeShared
    ? (getDb()
        .prepare(
          `SELECT * FROM learned_context
           WHERE superseded_by IS NULL AND risk_tier = 'fact'
             AND (user_id = ? OR scope = 'shared')`
        )
        .all(userId) as RawLearnedContextRow[])
    : (getDb()
        .prepare(
          `SELECT * FROM learned_context
           WHERE superseded_by IS NULL AND risk_tier = 'fact' AND user_id = ?`
        )
        .all(userId) as RawLearnedContextRow[]);
  return rows
    .map(mapLearnedContext)
    .filter((r) => r.expiresAt === null || r.expiresAt > nowIso)
    .filter((r) => r.symbol === null || normalizedSymbols.has(r.symbol.toUpperCase()));
}

export function listLearnedContext(userId: string): LearnedContextRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM learned_context WHERE user_id = ? AND superseded_by IS NULL ORDER BY asserted_at DESC")
    .all(userId) as RawLearnedContextRow[];
  return rows.map(mapLearnedContext);
}

export function supersedeLearnedContext(oldId: string, newId: string): void {
  getDb().prepare("UPDATE learned_context SET superseded_by = ? WHERE id = ?").run(newId, oldId);
}

/**
 * Count of live decomposed lesson rows (subject `lesson:*`) for a user. Used to decide whether the
 * free-text reflection blob may be DEMOTED out of the Bull system prompt: >0 structured lessons →
 * the blob is superseded; 0 → the blob remains the fallback (2026-07-04 composite review A).
 */
export function countLiveLessonRows(userId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM learned_context
       WHERE user_id = ? AND superseded_by IS NULL AND risk_tier = 'fact' AND subject LIKE 'lesson:%'`
    )
    .get(userId) as { n: number };
  return row.n;
}

// ── Reflection version history (per-account, append-only) ────────────────────
// 2026-07-04 composite review A ("Reflection keying + history", [Both]): reflections used to be a
// single user-level user_settings blob — two accounts clobbered each other and the overwrite left
// no history. Rows here are keyed (user_id, account_number), versioned monotonically, append-only
// (never UPDATEd), and carry the input-stats hash (the regeneration-gate signature) so "what inputs
// produced this reflection" is answerable per version.

export interface ReflectionVersionRow {
  id: string;
  userId: string;
  accountNumber: string;
  version: number;
  summary: string;
  inputStatsHash: string;
  createdAt: string;
}

interface RawReflectionVersionRow {
  id: string;
  user_id: string;
  account_number: string;
  version: number;
  summary: string;
  input_stats_hash: string;
  created_at: string;
}

function mapReflectionVersion(row: RawReflectionVersionRow): ReflectionVersionRow {
  return {
    id: row.id,
    userId: row.user_id,
    accountNumber: row.account_number,
    version: row.version,
    summary: row.summary,
    inputStatsHash: row.input_stats_hash,
    createdAt: row.created_at
  };
}

/** Append a new reflection version for (userId, accountNumber). Never overwrites prior versions. */
export function appendReflectionVersion(
  userId: string,
  accountNumber: string,
  summary: string,
  inputStatsHash: string
): ReflectionVersionRow {
  const db = getDb();
  const latest = db
    .prepare("SELECT MAX(version) AS v FROM reflection_versions WHERE user_id = ? AND account_number = ?")
    .get(userId, accountNumber) as { v: number | null };
  const row: ReflectionVersionRow = {
    id: randomUUID(),
    userId,
    accountNumber,
    version: (latest.v ?? 0) + 1,
    summary,
    inputStatsHash,
    createdAt: new Date().toISOString()
  };
  db.prepare(
    `INSERT INTO reflection_versions (id, user_id, account_number, version, summary, input_stats_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.userId, row.accountNumber, row.version, row.summary, row.inputStatsHash, row.createdAt);
  return row;
}

/** Latest reflection version for (userId, accountNumber), or null when none exists. */
export function getLatestReflectionVersion(userId: string, accountNumber: string): ReflectionVersionRow | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM reflection_versions WHERE user_id = ? AND account_number = ?
       ORDER BY version DESC LIMIT 1`
    )
    .get(userId, accountNumber) as RawReflectionVersionRow | undefined;
  return row ? mapReflectionVersion(row) : null;
}

/** Version history (newest first) for (userId, accountNumber) — for console diff/review surfaces. */
export function listReflectionVersions(userId: string, accountNumber: string, limit = 20): ReflectionVersionRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM reflection_versions WHERE user_id = ? AND account_number = ?
       ORDER BY version DESC LIMIT ?`
    )
    .all(userId, accountNumber, limit) as RawReflectionVersionRow[];
  return rows.map(mapReflectionVersion);
}

// ── RAG ingestion de-dup helpers ──────────────────────────────────────────────
// Keyed by (accession, doc_type) — globally unique for SEC filings, so no user scoping needed.

export interface IngestedAccessionRow {
  accession: string;
  docType: string;
  ticker: string;
  indexedAt: string;
  chunkCount: number;
}

/** Return true if this (accession, docType) pair has already been embedded. */
export function hasIngestedAccession(accession: string, docType: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM ingested_accessions WHERE accession = ? AND doc_type = ?")
    .get(accession, docType);
  return row != null;
}

/** Record a successfully-ingested accession so it is never re-embedded. */
export function insertIngestedAccession(accession: string, docType: string, ticker: string, chunkCount: number): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO ingested_accessions (accession, doc_type, ticker, indexed_at, chunk_count) VALUES (?, ?, ?, ?, ?)"
    )
    .run(accession, docType, ticker, new Date().toISOString(), chunkCount);
}

/** List all ingested accessions (admin/diagnostic). */
export function listIngestedAccessions(limit = 200): IngestedAccessionRow[] {
  const rows = getDb()
    .prepare("SELECT accession, doc_type, ticker, indexed_at, chunk_count FROM ingested_accessions ORDER BY indexed_at DESC LIMIT ?")
    .all(limit) as Array<{ accession: string; doc_type: string; ticker: string; indexed_at: string; chunk_count: number }>;
  return rows.map((r) => ({ accession: r.accession, docType: r.doc_type, ticker: r.ticker, indexedAt: r.indexed_at, chunkCount: r.chunk_count }));
}

// ── document_chunks content-hash dedup ─────────────────────────────────────

/** Check whether a chunk with this content_hash has already been embedded. */
export function hasDocumentChunk(contentHash: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 FROM document_chunks WHERE content_hash = ?")
    .get(contentHash);
  return row != null;
}

/** Batch-check which content_hashes are new (not yet stored). Returns the set of NEW hashes. */
export function filterNewDocumentChunks(
  hashes: Array<{ content_hash: string; symbol: string; source: string; chunk_id: string }>
): typeof hashes {
  if (hashes.length === 0) return [];
  // Build placeholders for IN clause — SQLite max is 999, well above any chunk batch.
  const placeholders = hashes.map(() => "?").join(",");
  const flatHashes = hashes.map((h) => h.content_hash);
  const existing = new Set<string>();
  const rows = getDb()
    .prepare(`SELECT content_hash FROM document_chunks WHERE content_hash IN (${placeholders})`)
    .all(...flatHashes) as Array<{ content_hash: string }>;
  for (const row of rows) existing.add(row.content_hash);
  return hashes.filter((h) => !existing.has(h.content_hash));
}

/** Record successfully-embedded chunks so their content_hash is never re-embedded. */
export function insertDocumentChunks(
  chunks: Array<{ content_hash: string; symbol: string; source: string; chunk_id: string }>
): void {
  if (chunks.length === 0) return;
  const stmt = getDb().prepare(
    "INSERT OR IGNORE INTO document_chunks (content_hash, symbol, source, chunk_id, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  const now = new Date().toISOString();
  const insertMany = getDb().transaction((rows: typeof chunks) => {
    for (const c of rows) stmt.run(c.content_hash, c.symbol, c.source, c.chunk_id, now);
  });
  insertMany(chunks);
}

/** Per-symbol chunk coverage stats (admin/diagnostic). */
export interface ChunkCoverageRow {
  symbol: string;
  chunkCount: number;
  latestAt: string;
}

export function getChunkCoverage(): ChunkCoverageRow[] {
  const rows = getDb()
    .prepare(
      "SELECT symbol, COUNT(*) as chunk_count, MAX(created_at) as latest_at FROM document_chunks GROUP BY symbol ORDER BY chunk_count DESC"
    )
    .all() as Array<{ symbol: string; chunk_count: number; latest_at: string }>;
  return rows.map((r) => ({ symbol: r.symbol, chunkCount: r.chunk_count, latestAt: r.latest_at }));
}

// ── learned_context_pending CRUD (risk-tier confirmation queue; userId-scoped) ──
// Every helper is ownership-scoped (WHERE user_id = ?). A queued row is a risk-tier candidate that is
// NOT in the brain — it only ever influences anything via the explicit human approve path, which
// applies it SAFELY (advisory promote / prompt append) and NEVER auto-mutates numeric policy.
interface RawLearnedContextPendingRow {
  id: string;
  user_id: string;
  scope: string;
  kind: string;
  subject: string;
  symbol: string | null;
  value: string;
  source: string;
  origin: string;
  risk_tier: string;
  classifier_reason: string | null;
  created_at: string;
  status: string;
  resolved_at: string | null;
}

function mapLearnedContextPending(row: RawLearnedContextPendingRow): LearnedContextPendingRow {
  return {
    id: row.id,
    userId: row.user_id,
    scope: row.scope as LearnedContextPendingRow["scope"],
    kind: row.kind as LearnedContextPendingRow["kind"],
    subject: row.subject,
    symbol: row.symbol,
    value: row.value,
    source: row.source,
    origin: row.origin as LearnedContextPendingRow["origin"],
    riskTier: row.risk_tier as LearnedContextPendingRow["riskTier"],
    classifierReason: row.classifier_reason,
    createdAt: row.created_at,
    status: row.status as LearnedContextPendingRow["status"],
    resolvedAt: row.resolved_at
  };
}

export function insertPendingLearnedContext(row: LearnedContextPendingRow): LearnedContextPendingRow {
  getDb()
    .prepare(
      `INSERT INTO learned_context_pending
        (id, user_id, scope, kind, subject, symbol, value, source, origin, risk_tier, classifier_reason, created_at, status, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id,
      row.userId,
      row.scope,
      row.kind,
      row.subject,
      row.symbol,
      row.value,
      row.source,
      row.origin,
      row.riskTier,
      row.classifierReason,
      row.createdAt,
      row.status,
      row.resolvedAt
    );
  return row;
}

export function listPendingLearnedContext(
  userId: string,
  status: LearnedContextPendingStatus = "pending"
): LearnedContextPendingRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM learned_context_pending
       WHERE user_id = ? AND status = ?
       ORDER BY created_at DESC`
    )
    .all(userId, status) as RawLearnedContextPendingRow[];
  return rows.map(mapLearnedContextPending);
}

export function getPendingLearnedContext(id: string, userId: string): LearnedContextPendingRow | null {
  const row = getDb()
    .prepare("SELECT * FROM learned_context_pending WHERE id = ? AND user_id = ?")
    .get(id, userId) as RawLearnedContextPendingRow | undefined;
  return row ? mapLearnedContextPending(row) : null;
}

/**
 * Ownership-scoped status transition. Returns true only when a row owned by `userId` was actually
 * updated (changes > 0) — so another user's row is a no-op false, and the API layer maps that to 404.
 */
export function setPendingLearnedContextStatus(
  id: string,
  userId: string,
  status: LearnedContextPendingStatus
): boolean {
  const resolvedAt = status === "pending" ? null : new Date().toISOString();
  const result = getDb()
    .prepare("UPDATE learned_context_pending SET status = ?, resolved_at = ? WHERE id = ? AND user_id = ?")
    .run(status, resolvedAt, id, userId);
  return result.changes > 0;
}
