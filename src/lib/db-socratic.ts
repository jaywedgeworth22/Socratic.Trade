// db-socratic.ts — durable Socratic decision case files, coaching, and framework proposals.
import crypto from "crypto";
import { audit, getDb } from "./db";
import type {
  OrderSide,
  PolicyDecision,
  SocraticDecisionCase,
  SocraticDecisionStatus,
  SocraticEvidenceItem,
  SocraticFrameworkProposal,
  SocraticFrameworkProposalStatus,
  SocraticRagAttribution,
  StrategyAuthority,
  TradeProposal
} from "./types";

// Coach notes live on socratic_decisions.coach_notes for fast prompt/display access, but that
// column must never grow unbounded. COACH_NOTES_LIVE_CAP notes stay "live" on the row; anything
// older is ARCHIVED (never deleted) into socratic_coach_note_archive with a receipt — replacing
// the old silent `slice(-20)` that used to drop the oldest note with no trace at all.
const COACH_NOTES_LIVE_CAP = 20;

type DecisionRow = {
  id: string;
  user_id: string;
  connected_account_id: string | null;
  run_id: string | null;
  proposal_id: string | null;
  account_number: string | null;
  symbol: string | null;
  side: string | null;
  status: string;
  authority: string;
  thesis: string;
  rationale: string;
  action: string;
  thesis_tag: string | null;
  regime: string | null;
  confidence_score: number | null;
  notional: number | null;
  model: string | null;
  red_team: string | null;
  policy_decision: string | null;
  evidence: string;
  rag_attributions: string;
  dissent: string;
  outcome: string | null;
  autonomy_override: string | null;
  lessons: string;
  coach_notes: string;
  created_at: string;
  updated_at: string;
};

type FrameworkRow = {
  id: string;
  user_id: string;
  connected_account_id: string | null;
  decision_id: string | null;
  run_id: string | null;
  status: string;
  priority: string;
  subsystem: string;
  title: string;
  rationale: string;
  proposed_change: string;
  evidence: string;
  owner_response: string | null;
  created_at: string;
  updated_at: string;
};

export interface ArchivedCoachNote {
  id: string;
  userId: string;
  decisionId: string;
  connectedAccountId?: string;
  note: string;
  archivedAt: string;
}

type ArchivedCoachNoteRow = {
  id: string;
  user_id: string;
  decision_id: string;
  connected_account_id: string | null;
  note: string;
  archived_at: string;
};

function rowToArchivedCoachNote(row: ArchivedCoachNoteRow): ArchivedCoachNote {
  return {
    id: row.id,
    userId: row.user_id,
    decisionId: row.decision_id,
    ...(row.connected_account_id ? { connectedAccountId: row.connected_account_id } : {}),
    note: row.note,
    archivedAt: row.archived_at
  };
}

/**
 * Archive coach notes that have aged off the live `socratic_decisions.coach_notes` window.
 * Append-only, never deleted — this is the durable record that replaces the old silent
 * `slice(-20)` truncation. Returns the archived rows (empty if nothing to archive).
 */
function archiveCoachNotes(
  decisionId: string,
  userId: string,
  connectedAccountId: string | undefined,
  notes: string[]
): ArchivedCoachNote[] {
  if (notes.length === 0) return [];
  const now = new Date().toISOString();
  const archived: ArchivedCoachNote[] = notes.map((note) => ({
    id: crypto.randomUUID(),
    userId,
    decisionId,
    ...(connectedAccountId ? { connectedAccountId } : {}),
    note,
    archivedAt: now
  }));
  const stmt = getDb().prepare(
    `INSERT INTO socratic_coach_note_archive (id, user_id, decision_id, connected_account_id, note, archived_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertMany = getDb().transaction((rows: ArchivedCoachNote[]) => {
    for (const row of rows) stmt.run(row.id, row.userId, row.decisionId, row.connectedAccountId ?? null, row.note, row.archivedAt);
  });
  insertMany(archived);
  return archived;
}

/** List every archived coach note for a decision, oldest first — the durable record of notes that aged off the live window. */
export function listArchivedCoachNotes(decisionId: string, userId: string = "local"): ArchivedCoachNote[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM socratic_coach_note_archive WHERE decision_id = ? AND user_id = ? ORDER BY archived_at ASC"
    )
    .all(decisionId, userId) as ArchivedCoachNoteRow[];
  return rows.map(rowToArchivedCoachNote);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToDecision(row: DecisionRow): SocraticDecisionCase {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.connected_account_id ? { connectedAccountId: row.connected_account_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.proposal_id ? { proposalId: row.proposal_id } : {}),
    ...(row.account_number ? { accountNumber: row.account_number } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.symbol ? { symbol: row.symbol } : {}),
    ...(row.side ? { side: row.side as OrderSide } : {}),
    status: row.status as SocraticDecisionStatus,
    authority: row.authority as StrategyAuthority,
    thesis: row.thesis,
    rationale: row.rationale,
    action: row.action,
    ...(row.thesis_tag ? { thesisTag: row.thesis_tag } : {}),
    ...(row.regime ? { regime: row.regime } : {}),
    ...(row.confidence_score != null ? { confidenceScore: row.confidence_score } : {}),
    ...(row.notional != null ? { notional: row.notional } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.red_team ? { redTeamVerdict: parseJson<TradeProposal["redTeamVerdict"] | undefined>(row.red_team, undefined) } : {}),
    ...(row.policy_decision ? { policyDecision: parseJson<PolicyDecision | undefined>(row.policy_decision, undefined) } : {}),
    evidence: parseJson<SocraticEvidenceItem[]>(row.evidence, []),
    ragAttributions: parseJson<SocraticRagAttribution[]>(row.rag_attributions, []),
    dissent: parseJson<SocraticEvidenceItem[]>(row.dissent, []),
    ...(row.outcome ? { outcome: parseJson<SocraticDecisionCase["outcome"] | undefined>(row.outcome, undefined) } : {}),
    ...(row.autonomy_override
      ? { autonomyOverride: parseJson<SocraticDecisionCase["autonomyOverride"] | undefined>(row.autonomy_override, undefined) }
      : {}),
    lessons: parseJson<string[]>(row.lessons, []),
    coachNotes: parseJson<string[]>(row.coach_notes, [])
  };
}

function rowToFramework(row: FrameworkRow): SocraticFrameworkProposal {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.connected_account_id ? { connectedAccountId: row.connected_account_id } : {}),
    ...(row.decision_id ? { decisionId: row.decision_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status as SocraticFrameworkProposalStatus,
    priority: row.priority as SocraticFrameworkProposal["priority"],
    subsystem: row.subsystem as SocraticFrameworkProposal["subsystem"],
    title: row.title,
    rationale: row.rationale,
    proposedChange: row.proposed_change,
    evidence: parseJson<SocraticEvidenceItem[]>(row.evidence, []),
    ...(row.owner_response ? { ownerResponse: row.owner_response } : {})
  };
}

export function upsertSocraticDecisionCase(input: {
  id?: string;
  userId?: string;
  connectedAccountId?: string;
  runId?: string;
  proposalId?: string;
  accountNumber?: string;
  symbol?: string;
  side?: OrderSide;
  status: SocraticDecisionStatus;
  authority: StrategyAuthority;
  thesis: string;
  rationale: string;
  action: string;
  thesisTag?: string;
  regime?: string;
  confidenceScore?: number;
  notional?: number;
  model?: string;
  redTeamVerdict?: TradeProposal["redTeamVerdict"];
  policyDecision?: PolicyDecision;
  evidence?: SocraticEvidenceItem[];
  ragAttributions?: SocraticRagAttribution[];
  dissent?: SocraticEvidenceItem[];
  outcome?: SocraticDecisionCase["outcome"];
  autonomyOverride?: SocraticDecisionCase["autonomyOverride"];
  lessons?: string[];
  coachNotes?: string[];
}): string {
  const now = new Date().toISOString();
  const id = input.id ?? input.proposalId ?? crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO socratic_decisions (
        id, user_id, connected_account_id, run_id, proposal_id, account_number, symbol, side, status,
        authority, thesis, rationale, action, thesis_tag, regime, confidence_score, notional, model,
        red_team, policy_decision, evidence, rag_attributions, dissent, outcome, autonomy_override,
        lessons, coach_notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        connected_account_id = excluded.connected_account_id,
        run_id = excluded.run_id,
        proposal_id = excluded.proposal_id,
        account_number = excluded.account_number,
        symbol = excluded.symbol,
        side = excluded.side,
        status = excluded.status,
        authority = excluded.authority,
        thesis = excluded.thesis,
        rationale = excluded.rationale,
        action = excluded.action,
        thesis_tag = excluded.thesis_tag,
        regime = excluded.regime,
        confidence_score = excluded.confidence_score,
        notional = excluded.notional,
        model = excluded.model,
        red_team = excluded.red_team,
        policy_decision = excluded.policy_decision,
        evidence = excluded.evidence,
        rag_attributions = excluded.rag_attributions,
        dissent = excluded.dissent,
        outcome = excluded.outcome,
        autonomy_override = excluded.autonomy_override,
        lessons = excluded.lessons,
        coach_notes = excluded.coach_notes,
        updated_at = excluded.updated_at`
    )
    .run(
      id,
      input.userId ?? "local",
      input.connectedAccountId ?? null,
      input.runId ?? null,
      input.proposalId ?? null,
      input.accountNumber ?? null,
      input.symbol ?? null,
      input.side ?? null,
      input.status,
      input.authority,
      input.thesis,
      input.rationale,
      input.action,
      input.thesisTag ?? null,
      input.regime ?? null,
      input.confidenceScore ?? null,
      input.notional ?? null,
      input.model ?? null,
      input.redTeamVerdict ? JSON.stringify(input.redTeamVerdict) : null,
      input.policyDecision ? JSON.stringify(input.policyDecision) : null,
      JSON.stringify(input.evidence ?? []),
      JSON.stringify(input.ragAttributions ?? []),
      JSON.stringify(input.dissent ?? []),
      input.outcome ? JSON.stringify(input.outcome) : null,
      input.autonomyOverride ? JSON.stringify(input.autonomyOverride) : null,
      JSON.stringify(input.lessons ?? []),
      JSON.stringify(input.coachNotes ?? []),
      now,
      now
    );
  return id;
}

export function listSocraticDecisionCases(
  userId: string = "local",
  opts: { limit?: number; connectedAccountId?: string; runId?: string } = {}
): SocraticDecisionCase[] {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const clauses = ["user_id = ?"];
  const args: unknown[] = [userId];
  if (opts.connectedAccountId) {
    clauses.push("connected_account_id = ?");
    args.push(opts.connectedAccountId);
  }
  if (opts.runId) {
    clauses.push("run_id = ?");
    args.push(opts.runId);
  }
  args.push(limit);
  const rows = getDb()
    .prepare(`SELECT * FROM socratic_decisions WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
    .all(...args) as DecisionRow[];
  return rows.map(rowToDecision);
}

export function getSocraticDecisionCase(id: string, userId: string = "local"): SocraticDecisionCase | undefined {
  const row = getDb().prepare("SELECT * FROM socratic_decisions WHERE id = ? AND user_id = ?").get(id, userId) as DecisionRow | undefined;
  return row ? rowToDecision(row) : undefined;
}

/**
 * Append an owner coach note to a decision case. This is the "coaching becomes durable learning"
 * closure: a coach note used to be a bare string capped at `slice(-20)` (the 21st note silently
 * deleted the oldest with no receipt) that never reached any prompt. Now, on every append:
 *   (a) the vector-memory case doc is RE-INDEXED (below) so the note is retrievable at decision
 *       time, not frozen at "coach_notes: none" the way it was written at creation;
 *   (b) the note is run through `ingestLearned` with origin 'coach' — a fact-tier note lands a
 *       durable `learned_context` row linked to this decision id; a risk/directive-tier note
 *       routes to the learned-context approval inbox (ingestLearned's existing non-chat routing —
 *       'coach' is not chat, so it is never silently dropped, only queued for human confirmation);
 *   (c) the live `coach_notes` column keeps only the most recent COACH_NOTES_LIVE_CAP notes —
 *       anything older is ARCHIVED (never deleted) with a receipt, replacing the old silent
 *       `slice(-20)`;
 *   (d) the promotion outcome is stamped as a `coaching`-kind evidence item on the case so later
 *       retrievals of this coached case carry "coached" + promoted-to-durable-lesson provenance
 *       (surfaced via `buildSocraticMemoryDocument`'s evidence summary).
 * Best-effort on (b): the coaching append itself must never fail because ingestLearned/the
 * semantic-gate LLM call failed — the receipt-worthy append (a)/(c) always happens synchronously;
 * (b)/(d) degrade to a "pending processing" evidence note on failure rather than throwing.
 */
export async function appendSocraticDecisionCoachNote(
  id: string,
  note: string,
  userId: string = "local"
): Promise<SocraticDecisionCase | undefined> {
  const existing = getSocraticDecisionCase(id, userId);
  if (!existing) return undefined;
  const trimmedNote = note.trim();
  const allNotes = [...existing.coachNotes, trimmedNote].filter(Boolean);
  const liveNotes = allNotes.slice(-COACH_NOTES_LIVE_CAP);
  const notesToArchive = allNotes.slice(0, Math.max(0, allNotes.length - COACH_NOTES_LIVE_CAP));

  // (b) Run the note through ingestLearned (origin 'coach') BEFORE the archival cut so the evidence
  // item below can describe exactly what happened to THIS note. Never let a classifier/LLM failure
  // block the append itself.
  let coachingEvidence: SocraticEvidenceItem;
  try {
    const { ingestLearned } = await import("./learned-context/store");
    const result = await ingestLearned(
      userId,
      {
        kind: "decision",
        subject: `coach:${id}`,
        value: trimmedNote,
        symbol: existing.symbol ?? undefined,
        source: "coach",
        confidence: 0.6,
        intent: trimmedNote
      },
      "coach"
    );
    if (result.written) {
      coachingEvidence = {
        kind: "coaching",
        title: "Coach note promoted to durable lesson",
        summary: trimmedNote,
        source: `learned_context:${result.written.id}`,
        tone: "positive",
        data: { learnedContextId: result.written.id, tier: result.tier }
      };
    } else if (result.pending) {
      coachingEvidence = {
        kind: "coaching",
        title: "Coach note routed to owner-approval inbox (risk-tier)",
        summary: trimmedNote,
        source: `learned_context_pending:${result.pending.id}`,
        tone: "warning",
        data: { pendingId: result.pending.id, tier: result.tier }
      };
    } else {
      // PII-dropped or (impossible for origin 'coach', which is not chat-hard-capped) chat-dropped.
      coachingEvidence = {
        kind: "coaching",
        title: "Coach note recorded (not durably ingested)",
        summary: `${trimmedNote} (dropped from learned_context: ${result.dropped ?? "unknown"})`,
        tone: "neutral",
        data: { dropped: result.dropped }
      };
    }
  } catch (err) {
    coachingEvidence = {
      kind: "coaching",
      title: "Coach note recorded (durable-learning ingest pending retry)",
      summary: trimmedNote,
      tone: "neutral",
      data: { error: err instanceof Error ? err.message : String(err) }
    };
  }

  upsertSocraticDecisionCase({
    ...existing,
    userId,
    coachNotes: liveNotes,
    evidence: [...existing.evidence, coachingEvidence]
  });
  audit("socratic_decision_coached", { decisionId: id, note: trimmedNote }, userId, existing.connectedAccountId);

  // (c) Archive notes that aged off the live window — append-only, never deleted — and emit a
  // receipt (audit event) ONLY when archival actually occurred this call.
  if (notesToArchive.length > 0) {
    const archived = archiveCoachNotes(id, userId, existing.connectedAccountId, notesToArchive);
    audit(
      "socratic_decision_coach_notes_archived",
      { decisionId: id, archivedCount: archived.length, archivedIds: archived.map((row) => row.id) },
      userId,
      existing.connectedAccountId
    );
  }

  const updated = getSocraticDecisionCase(id, userId);
  // (a) Re-index the vector-memory case doc so the appended note is actually retrievable at decision
  // time, not frozen at "coach_notes: none" the way it was written at creation
  // (indexSocraticDecisionMemory previously ran exactly once, at strategy.ts's original upsert).
  // The doc's dedupKeyPrefix ("socratic-decision") + stable id/contextId make this an in-place
  // upsert, not a duplicate vector. Dynamic import avoids a module cycle: socratic-memory ->
  // vector-db -> ./db (this barrel) -> db-socratic. Fire-and-forget + non-fatal, matching every
  // other indexSocraticDecisionMemory call site.
  //
  // Also index THIS note as its own standalone 'coach-note' vector (see socratic-memory.ts). The
  // note's index is its position in the all-time coach-note history for this decision
  // (existing.coachNotes.length BEFORE this append, i.e. allNotes.length - 1), so re-indexing the
  // decision doc on a LATER note never collides with this note's vector id/accession. Sequenced
  // (not Promise.all) so a transient failure in one never silently swallows the other via a single
  // shared .catch(), and so both awaits resolve against the identical cached module instance.
  if (updated) {
    void import("./socratic-memory")
      .then(async ({ indexSocraticDecisionMemory, indexCoachNoteMemory }) => {
        await indexSocraticDecisionMemory(updated);
        await indexCoachNoteMemory(updated, trimmedNote, allNotes.length - 1);
      })
      .catch((err) => {
        console.warn("[db-socratic] re-index after coach note failed:", err instanceof Error ? err.message : String(err));
      });
  }
  return updated;
}

export function createSocraticFrameworkProposal(input: {
  userId?: string;
  connectedAccountId?: string;
  decisionId?: string;
  runId?: string;
  priority?: SocraticFrameworkProposal["priority"];
  subsystem: SocraticFrameworkProposal["subsystem"];
  title: string;
  rationale: string;
  proposedChange: string;
  evidence?: SocraticEvidenceItem[];
}): string {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO socratic_framework_proposals (
        id, user_id, connected_account_id, decision_id, run_id, status, priority, subsystem,
        title, rationale, proposed_change, evidence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.userId ?? "local",
      input.connectedAccountId ?? null,
      input.decisionId ?? null,
      input.runId ?? null,
      input.priority ?? "medium",
      input.subsystem,
      input.title,
      input.rationale,
      input.proposedChange,
      JSON.stringify(input.evidence ?? []),
      now,
      now
    );
  audit("socratic_framework_proposal_created", { id, title: input.title, subsystem: input.subsystem }, input.userId ?? "local", input.connectedAccountId);
  return id;
}

export function listSocraticFrameworkProposals(
  userId: string = "local",
  opts: { limit?: number; status?: SocraticFrameworkProposalStatus; connectedAccountId?: string } = {}
): SocraticFrameworkProposal[] {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 25)));
  const clauses = ["user_id = ?"];
  const args: unknown[] = [userId];
  if (opts.status) {
    clauses.push("status = ?");
    args.push(opts.status);
  }
  if (opts.connectedAccountId) {
    clauses.push("connected_account_id = ?");
    args.push(opts.connectedAccountId);
  }
  args.push(limit);
  const rows = getDb()
    .prepare(`SELECT * FROM socratic_framework_proposals WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
    .all(...args) as FrameworkRow[];
  return rows.map(rowToFramework);
}

export function updateSocraticFrameworkProposalStatus(
  id: string,
  status: SocraticFrameworkProposalStatus,
  userId: string = "local",
  ownerResponse?: string
): SocraticFrameworkProposal | undefined {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      "UPDATE socratic_framework_proposals SET status = ?, owner_response = COALESCE(?, owner_response), updated_at = ? WHERE id = ? AND user_id = ?"
    )
    .run(status, ownerResponse ?? null, now, id, userId);
  const row = getDb().prepare("SELECT * FROM socratic_framework_proposals WHERE id = ? AND user_id = ?").get(id, userId) as FrameworkRow | undefined;
  if (!row) return undefined;
  const framework = rowToFramework(row);
  audit("socratic_framework_proposal_resolved", { id, status, ownerResponse }, userId, framework.connectedAccountId);
  return framework;
}
