// The learned_context store: the ONLY writer/reader of the learned_context table on behalf of the
// learning loop. It is the safety boundary between producers (chat salience, post-mortem) and the
// strategy brain.
//
// WRITE side (ingestLearned):
//   - Runs the fail-closed classifier (classify.ts) + PII gate on every candidate.
//   - tier 'fact'                 → written as a row (scope='private' in this slice).
//   - tier 'risk'/'strategy-directive' → AUDIT-LOG-AND-DROP. The pending-changes queue is a later
//     slice, so nothing above 'fact' is written ANYWHERE that could reach the brain.
//   - Chat-origin candidates are HARD-CAPPED at 'fact': a chat message can never produce a
//     risk-tier change; if it classifies above 'fact' it is dropped+audited.
//
// READ side (retrieveLearnedContext):
//   - READ-ONLY. Returns advisory fact strings for the prompt. Never returns numbers that feed
//     sizing/weights — its output is consumed only as a labeled DATA section in the strategy prompt.

import { randomUUID } from "crypto";
import {
  audit,
  findLiveLearnedContextBySubject,
  getStrategyPrompt,
  insertLearnedContext,
  insertPendingLearnedContext,
  listLearnedContextForDecision,
  setStrategyPrompt,
  supersedeLearnedContext
} from "../db";
import type {
  LearnedContextCandidate,
  LearnedContextOrigin,
  LearnedContextPendingRow,
  LearnedContextRow
} from "../types";
import { classifyRiskTier, hasPii } from "./classify";

export interface IngestLearnedResult {
  written: LearnedContextRow | null;
  /** 'pii' | 'risk_dropped' | 'chat_risk_dropped' when nothing was written and nothing was queued. */
  dropped: "pii" | "risk_dropped" | "chat_risk_dropped" | null;
  /** Set when a risk-tier autonomous/ingest candidate was routed to the confirmation queue. */
  pending: LearnedContextPendingRow | null;
  /** Convenience id of the queued pending row (mirrors `pending?.id`). */
  pendingId: string | null;
  tier: LearnedContextRow["riskTier"];
}

/**
 * Classify + gate a single candidate. Routing:
 *   - PII                                  → drop+audit (never written/queued, any tier).
 *   - tier 'fact'                          → written as a private learned_context row.
 *   - tier 'risk'/'strategy-directive':
 *       · origin 'chat'                    → HARD-CAP: drop+audit, NEVER queued (chat can never create a
 *                                            pending risk item).
 *       · origin 'autonomous'/'ingest'     → INSERT a learned_context_pending row (status 'pending') for
 *                                            human confirmation; audit 'learned_context.pending'. Approval
 *                                            applies it SAFELY and NEVER auto-mutates numeric policy.
 */
export function ingestLearned(
  userId: string,
  candidate: LearnedContextCandidate,
  origin: LearnedContextOrigin
): IngestLearnedResult {
  // PII gate first — an SSN/card number is never written regardless of tier.
  if (hasPii(candidate.value)) {
    audit("learned_context.drop", { userId, origin, reason: "pii", subject: candidate.subject }, userId);
    return { written: null, dropped: "pii", pending: null, pendingId: null, tier: "fact" };
  }

  const tier = classifyRiskTier(candidate);

  if (tier !== "fact") {
    // CHAT origin is HARD-CAPPED at 'fact' — a chat message can NEVER produce a pending risk item.
    // Preserve the audit-drop seam exactly for chat.
    if (origin === "chat") {
      audit(
        "learned_context.drop",
        { userId, origin, reason: "chat_risk_dropped", tier, subject: candidate.subject, value: candidate.value },
        userId
      );
      return { written: null, dropped: "chat_risk_dropped", pending: null, pendingId: null, tier };
    }

    // Autonomous / ingest risk-tier candidates route to the human confirmation queue instead of
    // being dropped. The queued row is NOT in the brain; it only ever applies via explicit approval.
    const pending: LearnedContextPendingRow = {
      id: randomUUID(),
      userId,
      scope: "private",
      kind: candidate.kind,
      subject: candidate.subject,
      symbol: candidate.symbol ? candidate.symbol.toUpperCase() : null,
      value: candidate.value,
      source: candidate.source ?? "inferred",
      origin,
      riskTier: tier,
      classifierReason: `classified '${tier}' (fail-closed); queued for human confirmation`,
      createdAt: new Date().toISOString(),
      status: "pending",
      resolvedAt: null
    };
    insertPendingLearnedContext(pending);
    audit(
      "learned_context.pending",
      { userId, origin, tier, pendingId: pending.id, subject: candidate.subject, value: candidate.value },
      userId
    );
    return { written: null, dropped: null, pending, pendingId: pending.id, tier };
  }

  const symbol = candidate.symbol ? candidate.symbol.toUpperCase() : null;
  const nowIso = new Date().toISOString();

  // Reconcile-on-write: if a live fact for this (kind, subject, symbol) exists with a different
  // value, supersede it; if identical, no-op (don't accumulate duplicates).
  const existing = findLiveLearnedContextBySubject(userId, candidate.kind, candidate.subject, symbol);
  if (existing && existing.value === candidate.value) {
    return { written: existing, dropped: null, pending: null, pendingId: null, tier };
  }

  const row: LearnedContextRow = {
    id: randomUUID(),
    userId,
    // Slice scope decision: write fact rows as private ONLY. Cross-user shared facts are deferred.
    scope: "private",
    kind: candidate.kind,
    subject: candidate.subject,
    symbol,
    value: candidate.value,
    source: candidate.source ?? "inferred",
    origin,
    riskTier: "fact",
    confidence: candidate.confidence ?? 0.5,
    contributorUserId: userId,
    assertedAt: nowIso,
    supersededBy: null,
    expiresAt: null
  };
  insertLearnedContext(row);
  if (existing) supersedeLearnedContext(existing.id, row.id);
  audit(
    "learned_context.write",
    { userId, origin, kind: row.kind, subject: row.subject, symbol: row.symbol, op: existing ? "supersede" : "append" },
    userId
  );
  return { written: row, dropped: null, pending: null, pendingId: null, tier };
}

/**
 * READ-ONLY retrieval of advisory fact rows for a decision. Returns the live private fact rows
 * (plus opted-in shared rows once that slice lands) relevant to the given symbols, formatted as
 * advisory bullet strings for the strategy prompt's `learnedContext` DATA section.
 *
 * The `regime` argument is accepted for forward-compatibility (regime-conditioned facts) but is
 * not yet used as a filter in this slice.
 */
export function retrieveLearnedContext(
  userId: string,
  symbols: string[],
  _regime?: string,
  options: { includeShared?: boolean; limit?: number; perContributorCap?: number } = {}
): string[] {
  const limit = options.limit ?? 12;
  const perContributorCap = options.perContributorCap ?? 6;
  const rows = listLearnedContextForDecision(userId, symbols, options.includeShared ?? false);

  // Per-contributor cap so one prolific source can't crowd out the rest (matters once shared rows
  // are enabled; harmless for the private-only slice).
  const perContributor = new Map<string, number>();
  const selected: LearnedContextRow[] = [];
  for (const row of rows.sort((a, b) => b.assertedAt.localeCompare(a.assertedAt))) {
    const key = row.contributorUserId ?? row.userId;
    const used = perContributor.get(key) ?? 0;
    if (used >= perContributorCap) continue;
    perContributor.set(key, used + 1);
    selected.push(row);
    if (selected.length >= limit) break;
  }

  return selected.map((row) => {
    const sym = row.symbol ? `[${row.symbol}] ` : "";
    return `- ${sym}${row.subject}: ${row.value}`;
  });
}

// ── Pending-queue APPROVAL (safety-critical) ────────────────────────────────────
// THE LINE WE DO NOT CROSS: an approval NEVER auto-derives or auto-writes a numeric policy change.
// setPolicy / validatePolicy stay reachable ONLY via the explicit human PUT /api/policy. Nothing in
// this section imports or calls setPolicy. Any real numeric risk-limit change remains a separate
// manual action the human takes in Risk settings.

/**
 * Build the delimited, attributed AI-LEARNED block for an approved strategy-directive. The block is
 * keyed by the pending row's id so re-approval is idempotent (replace-in-place, never duplicate).
 */
function buildLearnedBlock(id: string, value: string, dateIso: string): string {
  const day = dateIso.slice(0, 10); // YYYY-MM-DD
  return `<!-- AI-LEARNED ${id} ${day} -->\n${value}\n<!-- /AI-LEARNED -->`;
}

/**
 * APPEND an attributed AI-LEARNED block to the strategy prompt, idempotent by id. If a block with the
 * same id already exists it is REPLACED in place (re-approve never duplicates); otherwise the new block
 * is appended after a blank-line separator. This is approved guidance TEXT — it does NOT touch numeric
 * policy limits. Exported for direct unit testing of the merge invariant.
 */
export function mergeStrategyDirectiveBlock(currentPrompt: string, id: string, value: string, dateIso: string): string {
  const block = buildLearnedBlock(id, value, dateIso);
  // Match an existing block for THIS id (any prior date) so re-approval replaces, not duplicates.
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existingBlock = new RegExp(`<!-- AI-LEARNED ${escapedId} [^>]*-->[\\s\\S]*?<!-- /AI-LEARNED -->`);
  if (existingBlock.test(currentPrompt)) {
    return currentPrompt.replace(existingBlock, block);
  }
  return `${currentPrompt}\n\n${block}`;
}

/**
 * Apply an APPROVED pending row per its tier. Safety-critical — see the header above.
 *   - 'strategy-directive' → APPEND an attributed, idempotent AI-LEARNED block to the strategy prompt
 *     via setStrategyPrompt (append-not-replace; re-approve replaces just that id's block).
 *   - 'risk'               → PROMOTE to an advisory learned_context row via insertLearnedContext
 *     (scope 'private', riskTier 'risk', origin preserved). It becomes soft DATA the LLM reads; the
 *     human approval IS the gate. NEVER calls setPolicy.
 * The caller is responsible for the status transition + 'learned_context.approve' audit so ownership
 * is enforced once at the route layer.
 */
export function applyApprovedPending(pending: LearnedContextPendingRow): void {
  if (pending.riskTier === "strategy-directive") {
    const current = getStrategyPrompt(pending.userId);
    const merged = mergeStrategyDirectiveBlock(current, pending.id, pending.value, new Date().toISOString());
    setStrategyPrompt(merged, pending.userId);
    return;
  }

  // tier 'risk' → advisory promote. Lives in the learned_context store as soft DATA only.
  const row: LearnedContextRow = {
    id: randomUUID(),
    userId: pending.userId,
    scope: "private",
    kind: pending.kind,
    subject: pending.subject,
    symbol: pending.symbol ? pending.symbol.toUpperCase() : null,
    value: pending.value,
    source: pending.source,
    origin: pending.origin,
    riskTier: "risk",
    confidence: 0.5,
    contributorUserId: pending.userId,
    assertedAt: new Date().toISOString(),
    supersededBy: null,
    expiresAt: null
  };
  insertLearnedContext(row);
}
