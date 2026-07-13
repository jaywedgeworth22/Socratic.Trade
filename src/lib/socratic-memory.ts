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

export function buildSocraticMemoryDocument(
  decision: SocraticDecisionCase,
  accountEnvironment?: "paper" | "live"
): ContextDocument {
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
  // Multi-horizon outcome ladder (15m/1h/1d/1w). Each row is either a measured, SPY-relative
  // return or an HONEST 'unresolvable(reason)' — rendered so retrieval-time readers see coverage,
  // not just the survivors. Re-indexed by the outcome engine on every lifecycle update.
  const horizonText = (decision.outcome?.outcomes ?? [])
    .map((row) =>
      row.resolution === "ok"
        ? `${row.horizon} ${typeof row.returnPct === "number" ? `${row.returnPct >= 0 ? "+" : ""}${row.returnPct}%` : "n/a"}${
            typeof row.spyExcessPct === "number" ? ` (vs SPY ${row.spyExcessPct >= 0 ? "+" : ""}${row.spyExcessPct}%)` : ""
          }`
        : `${row.horizon} unresolvable(${row.reason ?? "unknown"})`
    )
    .join(", ");
  const outcome = decision.outcome
    ? `${decision.outcome.status}${typeof decision.outcome.returnPct === "number" ? `; return_pct=${decision.outcome.returnPct}` : ""}${typeof decision.outcome.pnlUsd === "number" ? `; pnl_usd=${decision.outcome.pnlUsd}` : ""}${horizonText ? `; horizons: ${horizonText}` : ""}${decision.outcome.note ? `; note=${compact(decision.outcome.note)}` : ""}`
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
      memory_scope: "account",
      decision_id: decision.id,
      final_action: finalAction(decision),
      ...(decision.proposalId ? { proposal_id: decision.proposalId } : {}),
      ...(decision.runId ? { run_id: decision.runId } : {}),
      ...(decision.side ? { side: decision.side } : {}),
      authority: decision.authority,
      ...(decision.thesisTag ? { thesis_tag: decision.thesisTag } : {}),
      ...(decision.regime ? { entry_market_regime: decision.regime } : {}),
      ...(decision.connectedAccountId ? { connected_account_id: decision.connectedAccountId } : {}),
      ...(accountEnvironment ? {
        account_environment: accountEnvironment,
        transfer_state: accountEnvironment === "paper" ? "candidate" : "not_applicable"
      } : {})
    }
  };
}

export async function indexSocraticDecisionMemory(decision: SocraticDecisionCase): Promise<StoreContextsResult> {
  const { getConnectedAccount } = await import("./db");
  const { storeContexts } = await import("./vector-db");
  const accountEnvironment = decision.connectedAccountId
    ? getConnectedAccount(decision.connectedAccountId, decision.userId)?.environment
    : undefined;
  return storeContexts(
    [buildSocraticMemoryDocument(decision, accountEnvironment)],
    decision.userId,
    { dedupKeyPrefix: "socratic-decision" }
  );
}
