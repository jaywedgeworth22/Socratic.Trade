import type { ContextDocument, StoreContextsResult } from "./vector-db";
import type { SocraticDecisionCase, SocraticEvidenceItem, SocraticRagAttribution } from "./types";

function compact(value: string | undefined, fallback: string = "n/a"): string {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function summarizeEvidence(items: SocraticEvidenceItem[], fallback: string): string {
  const summaries = items
    .slice(0, 5)
    .map((item) => `${compact(item.title)}: ${compact(item.summary)}`)
    .filter(Boolean);
  return summaries.length > 0 ? summaries.join(" | ") : fallback;
}

function summarizeRag(items: SocraticRagAttribution[]): string {
  const summaries = items
    .slice(0, 5)
    .map((item) => {
      const source = compact(item.source ?? item.docType, "retrieved context");
      const score = typeof item.score === "number" ? ` score=${item.score.toFixed(3)}` : "";
      return `${source}${score}: ${compact(item.contribution || item.text)}`;
    })
    .filter(Boolean);
  return summaries.length > 0 ? summaries.join(" | ") : "No retrieved memory/context was attached to this case.";
}

function finalAction(decision: SocraticDecisionCase): string {
  return decision.status.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export function buildSocraticMemoryDocument(decision: SocraticDecisionCase): ContextDocument {
  const symbol = decision.symbol ?? "PORTFOLIO";
  const criticCounterArgument =
    decision.redTeamVerdict?.reason ??
    summarizeEvidence(decision.dissent, "No explicit critic objection was recorded.");
  const policyOutcome = decision.policyDecision?.approved
    ? "approved"
    : `blocked: ${(decision.policyDecision?.reasons ?? []).join(" | ") || "n/a"}`;
  const override = decision.autonomyOverride
    ? `requested=${decision.autonomyOverride.requested === true}; applied=${decision.autonomyOverride.applied}; thesis=${compact(decision.autonomyOverride.thesis)}; conflicts=${decision.autonomyOverride.conflicts.join(" | ") || "n/a"}`
    : "none";
  const outcome = decision.outcome
    ? `${decision.outcome.status}${typeof decision.outcome.returnPct === "number" ? `; return_pct=${decision.outcome.returnPct}` : ""}${typeof decision.outcome.pnlUsd === "number" ? `; pnl_usd=${decision.outcome.pnlUsd}` : ""}${decision.outcome.note ? `; note=${compact(decision.outcome.note)}` : ""}`
    : "pending";

  const text = [
    "Socratic institutional memory case",
    `ticker: ${symbol}`,
    `timestamp: ${decision.createdAt}`,
    `final_action: ${finalAction(decision)}`,
    `side: ${decision.side ?? "n/a"}`,
    `authority: ${decision.authority}`,
    `thesis_tag: ${decision.thesisTag ?? "n/a"}`,
    `entry_market_regime: ${decision.regime ?? "n/a"}`,
    `broker_argument: ${compact(decision.thesis)} -- ${compact(decision.rationale)}`,
    `critic_counter_argument: ${compact(criticCounterArgument)}`,
    `policy_outcome: ${policyOutcome}`,
    `autonomy_override: ${override}`,
    `rag_contribution: ${summarizeRag(decision.ragAttributions)}`,
    `evidence: ${summarizeEvidence(decision.evidence, "No structured evidence was attached.")}`,
    `outcome: ${outcome}`,
    `lessons: ${decision.lessons.length > 0 ? decision.lessons.map((lesson) => compact(lesson)).join(" | ") : "pending"}`,
    `coach_notes: ${decision.coachNotes.length > 0 ? decision.coachNotes.map((note) => compact(note)).join(" | ") : "none"}`
  ].join("\n");

  return {
    text,
    metadata: {
      symbol,
      source: "socratic-memory",
      timestamp: decision.createdAt,
      accession: decision.id,
      doc_type: "socratic-decision",
      decision_id: decision.id,
      final_action: finalAction(decision),
      ...(decision.proposalId ? { proposal_id: decision.proposalId } : {}),
      ...(decision.runId ? { run_id: decision.runId } : {}),
      ...(decision.side ? { side: decision.side } : {}),
      authority: decision.authority,
      ...(decision.thesisTag ? { thesis_tag: decision.thesisTag } : {}),
      ...(decision.regime ? { entry_market_regime: decision.regime } : {}),
      ...(decision.connectedAccountId ? { connected_account_id: decision.connectedAccountId } : {})
    }
  };
}

export async function indexSocraticDecisionMemory(decision: SocraticDecisionCase): Promise<StoreContextsResult> {
  const { storeContexts } = await import("./vector-db");
  return storeContexts([buildSocraticMemoryDocument(decision)], decision.userId, { dedupKeyPrefix: "socratic-decision" });
}

/**
 * COACH-NOTE VECTORS — a coaching theme spread across many notes on many decisions ("consistently
 * timid on high-conviction entries") has no retrievable representation as long as coach notes only
 * ever live embedded inside the parent decision-case doc. This builds ONE small, standalone vector
 * per coach note (doc_type 'coach-note'), so a future episodic-retrieval pass can query coaching
 * guidance directly instead of only ever finding it buried in a specific case's full text.
 *
 * Shape is deliberately simple per the design note: text is just the note (so it embeds as the
 * owner's own words, not a templated wrapper), and metadata carries exactly the fields the
 * episodic-retrieval lane needs to filter/join: {symbol, thesis_tag, regime, decision_id}. `noteIndex`
 * makes the id/accession unique per note (multiple notes can exist on one decision), so this is
 * ALWAYS an additive new vector, never an overwrite of a sibling note or the parent decision doc
 * (which uses dedupKeyPrefix "socratic-decision", a disjoint namespace from "coach-note" here).
 */
export function buildCoachNoteMemoryDocument(
  decision: Pick<SocraticDecisionCase, "id" | "symbol" | "thesisTag" | "regime" | "connectedAccountId" | "createdAt">,
  note: string,
  noteIndex: number
): ContextDocument {
  const symbol = decision.symbol ?? "PORTFOLIO";
  return {
    text: note,
    metadata: {
      symbol,
      source: "socratic-coach-note",
      timestamp: new Date().toISOString(),
      accession: `${decision.id}:${noteIndex}`,
      doc_type: "coach-note",
      decision_id: decision.id,
      ...(decision.thesisTag ? { thesis_tag: decision.thesisTag } : {}),
      ...(decision.regime ? { regime: decision.regime } : {}),
      ...(decision.connectedAccountId ? { connected_account_id: decision.connectedAccountId } : {})
    }
  };
}

/**
 * Store a single coach note as its own retrievable vector (doc_type 'coach-note'). Call this once
 * per NEW note (the caller passes the note's stable index within the decision's full coach-note
 * history, e.g. `existing.coachNotes.length` before the append, so re-indexing the same decision's
 * OTHER notes never collides). Best-effort: callers should treat failures as non-fatal, matching
 * `indexSocraticDecisionMemory`.
 */
export async function indexCoachNoteMemory(
  decision: Pick<SocraticDecisionCase, "id" | "userId" | "symbol" | "thesisTag" | "regime" | "connectedAccountId" | "createdAt">,
  note: string,
  noteIndex: number
): Promise<StoreContextsResult> {
  const { storeContexts } = await import("./vector-db");
  return storeContexts([buildCoachNoteMemoryDocument(decision, note, noteIndex)], decision.userId, {
    dedupKeyPrefix: "coach-note"
  });
}
