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
  insertLearnedContext,
  listLearnedContextForDecision,
  supersedeLearnedContext
} from "../db";
import type {
  LearnedContextCandidate,
  LearnedContextOrigin,
  LearnedContextRow
} from "../types";
import { classifyRiskTier, hasPii } from "./classify";

export interface IngestLearnedResult {
  written: LearnedContextRow | null;
  /** 'pii' | 'risk_dropped' | 'chat_risk_dropped' when nothing was written. */
  dropped: "pii" | "risk_dropped" | "chat_risk_dropped" | null;
  tier: LearnedContextRow["riskTier"];
}

/**
 * Classify + gate a single candidate and, only for tier 'fact', write a learned_context row.
 * Everything else is audited and dropped (no pending queue in this slice).
 */
export function ingestLearned(
  userId: string,
  candidate: LearnedContextCandidate,
  origin: LearnedContextOrigin
): IngestLearnedResult {
  // PII gate first — an SSN/card number is never written regardless of tier.
  if (hasPii(candidate.value)) {
    audit("learned_context.drop", { userId, origin, reason: "pii", subject: candidate.subject }, userId);
    return { written: null, dropped: "pii", tier: "fact" };
  }

  const tier = classifyRiskTier(candidate);

  if (tier !== "fact") {
    // Above 'fact' → drop+audit. Chat-origin gets its own audit reason so the hard-cap is visible.
    const reason = origin === "chat" ? "chat_risk_dropped" : "risk_dropped";
    audit(
      "learned_context.drop",
      { userId, origin, reason, tier, subject: candidate.subject, value: candidate.value },
      userId
    );
    return { written: null, dropped: reason, tier };
  }

  const symbol = candidate.symbol ? candidate.symbol.toUpperCase() : null;
  const nowIso = new Date().toISOString();

  // Reconcile-on-write: if a live fact for this (kind, subject, symbol) exists with a different
  // value, supersede it; if identical, no-op (don't accumulate duplicates).
  const existing = findLiveLearnedContextBySubject(userId, candidate.kind, candidate.subject, symbol);
  if (existing && existing.value === candidate.value) {
    return { written: existing, dropped: null, tier };
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
  return { written: row, dropped: null, tier };
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
