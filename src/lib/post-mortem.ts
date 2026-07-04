import { randomUUID } from "crypto";
import {
  getActiveConnectedAccount,
  getDb,
  audit,
  getInternalSetting,
  setInternalSetting,
  getPolicy,
  upsertFillExcursionsByKey,
  insertLearnedContext,
  findLiveLearnedContextBySubject,
  supersedeLearnedContext,
  countLiveLessonRows,
  appendReflectionVersion,
  getLatestReflectionVersion
} from "./db";
import { recordLlmUsage, extractLlmUsage } from "./llm-usage";
import { getRegimeScorecard, getThesisScorecard, getClosedLotsDetailed } from "./performance";
import { ingestLearned } from "./learned-context/store";
import type { ThesisStat, ClosedLot } from "./performance";
import type { LearnedContextRow } from "./types";
import type { ContextDocument } from "./vector-db";
import { getExcursionsByThesis, enrichClosedLotsWithExcursions } from "./learning-loop";
import { deriveExecutionState, fillSourceForExecutionMode, llmExecutionMode, llmModeClarification } from "./execution-mode";
import { LLM_OUTPUT_TOKEN_CAPS, llmFetch } from "./llm-request";
import { resolveLlmEndpoint } from "./llm-provider";
import { buildLlmRequestBody, llmAuthHeaders, extractLlmText } from "./llm-call";
import { humanizeLlmError } from "./llm-errors";
import { withLlmGeneration } from "./observability";
import { isOverLlmBudget } from "./llm-budget";
import { summarizeOpenAiRequest, summarizeOpenAiResponseText } from "./telemetry-sanitize";

export async function generateReflectionSummary(accountNumber: string, userId: string = "local"): Promise<void> {
  const db = getDb();
  const policy = getPolicy(userId);
  const { url, key: openaiKey, model: resolvedModel, provider, keySource, keyRef, transport } = resolveLlmEndpoint(policy, userId, "https://api.openai.com/v1/chat/completions");
  if (!openaiKey) return;
  
  // Fetch latest 50 fill events with their corresponding proposals
  const rows = db.prepare(`
    SELECT
      f.symbol,
      f.side,
      f.quantity,
      f.price,
      f.notional,
      f.filled_at,
      p.trade_thesis_tag,
      p.entry_market_regime,
      p.proposal
    FROM fill_events f
    LEFT JOIN trade_proposals p ON f.proposal_id = p.id
    WHERE f.account_number = ? AND f.user_id = ? AND f.status = 'filled'
    ORDER BY f.filled_at DESC
    LIMIT 50
  `).all(accountNumber, userId) as any[];

  if (rows.length === 0) return;

  // Gate: only regenerate when the trade history actually changed since the last
  // reflection. The signature is (#trades, latest fill time). This skips a whole
  // LLM call on the common run where nothing filled, and keeps the Bull agent's
  // system prompt stable run-to-run so the provider's prompt cache can hit.
  // Keyed by (userId, accountNumber) — composite review A "Reflection keying + history" [Both]:
  // the old user-level key made two accounts clobber each other's signature and wrongly
  // suppress regeneration on the account that ran second.
  const signature = `${rows.length}:${rows[0]?.filled_at ?? ""}`;
  const signatureKey = reflectionSignatureKey(userId, accountNumber);
  if (getInternalSetting<string>(signatureKey) === signature) return;

  const tradeData = rows.map((r) => ({
    symbol: r.symbol,
    side: r.side,
    quantity: r.quantity,
    price: r.price,
    notional: r.notional,
    filledAt: r.filled_at,
    thesisTag: r.trade_thesis_tag,
    regime: r.entry_market_regime,
    rationale: r.proposal ? truncate(JSON.parse(r.proposal).rationale, 240) : undefined
  }));

  // Realized outcomes grouped by thesis tag and by market regime, plus MAE/MFE
  // timing stats, so the reflection is grounded in what actually made or lost money
  // and how well exits were timed — not just what was traded. Excursions hit the
  // network, but this whole function is gated above, so it runs only on new trades.
  const executionState = deriveExecutionState(policy, getActiveConnectedAccount(userId));
  const source = fillSourceForExecutionMode(executionState);

  // Budget guard: when over the daily LLM budget, skip ONLY the LLM reflection call — but still run the
  // non-LLM excursion enrichment (persistExcursionsBackground: MAE/MFE, no OpenAI key required). A spend
  // cap suppresses LLM spend, not non-LLM maintenance, so returning here (instead of before) keeps
  // excursion data current on over-budget days. Default OFF → this branch never taken (runs normally).
  if (isOverLlmBudget(userId)) {
    persistExcursionsBackground(accountNumber, source, userId);
    return;
  }

  const executionMode = llmExecutionMode(executionState);
  const outcomesByThesis = getThesisScorecard(accountNumber, source, {}, userId);
  const outcomesByRegime = getRegimeScorecard(accountNumber, source, {}, userId);
  const timingByThesis = await getExcursionsByThesis(accountNumber, source, { userId }).catch(() => []);

  // Decomposed structured lessons (composite review A, [Both]): discrete tagged
  // {regime, thesisTag, dominantFactor} rows in learned_context + doc_type 'lesson' vectors,
  // computed deterministically from closed lots — no LLM involved. Best-effort: a failure here
  // never blocks the reflection call below.
  try {
    await writeDecomposedLessons(userId, accountNumber, getClosedLotsDetailed(accountNumber, source, userId));
  } catch (error) {
    console.error("Failed to write decomposed reflection lessons:", error);
  }

  const systemPrompt = `You are the Post-Mortem Reflection Engine.
Review the recent trades together with:
- 'executionMode': broker/paper is a broker-hosted sandbox such as Alpaca Paper; broker/live is a production broker account.
- 'outcomesByThesis' / 'outcomesByRegime': realized win rate, average return, and total P&L grouped by 'thesisTag' and by 'regime' respectively (these mirror the proposal's tradeThesisTag and entryMarketRegime).
- 'timingByThesis': average maximum adverse excursion (avgMaePct, pain endured), average maximum favorable excursion (avgMfePct, the move that was available), and capturePct (share of the favorable move actually realized; low => exiting winners too early, large negative avgMaePct => holding losers through deep drawdowns).
Extract actionable, outcome-grounded lessons: which thesis tags and regimes are profitable vs losing, and whether exits are mistimed.
Return a single concise paragraph (<= 130 words) that is specific and directive. It is fed back into the Bull Agent's prompt on future runs to improve trading accuracy.`;

  const userContent = JSON.stringify({
    executionMode,
    executionModeClarification: llmModeClarification(executionState),
    recentTrades: tradeData,
    outcomesByThesis,
    outcomesByRegime,
    timingByThesis
  });

  const model = resolvedModel;

  const body = buildLlmRequestBody(
    { provider, transport },
    {
      model,
      systemPrompt,
      userContent,
      maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.postMortemReflection,
      reasoningEffort: policy.llmReasoningEffort
    }
  );

  try {
    const traced = await withLlmGeneration(
      {
        name: "trading.post-mortem.reflection",
        model,
        userId,
        input: summarizeOpenAiRequest(body),
        metadata: {
          endpoint: url,
          transport,
          tradeCount: tradeData.length,
          executionMode,
          internalSource: source
        },
        tags: ["post-mortem", "reflection"],
        output: (result) => summarizeOpenAiResponseText(result.text)
      },
      async () => {
        const response = await llmFetch(url, {
          method: "POST",
          headers: llmAuthHeaders({ provider, key: openaiKey }),
          body: JSON.stringify(body)
        });

        if (!response.ok) {
          console.warn("Post-mortem LLM call failed:", humanizeLlmError(await response.text().catch(() => ""), { provider, status: response.status }));
          return { text: undefined };
        }

        const payload = await response.json();
        recordLlmUsage({ userId, provider, model, context: "post-mortem", keySource, keyRef, ...extractLlmUsage(payload) });
        const text = extractLlmText(payload);

        return { text: typeof text === "string" ? text : undefined };
      }
    );

    if (traced.text) {
      // Append-only per-account version row (never overwrites history); the input-stats hash is
      // the same signature the regeneration gate uses, so each version records what produced it.
      const version = appendReflectionVersion(userId, accountNumber, traced.text, signature);
      setInternalSetting(signatureKey, signature);
      audit("post_mortem_reflection", {
        summary: traced.text,
        accountNumber,
        reflectionVersion: version.version,
        inputStatsHash: signature,
        tradeCount: tradeData.length,
        outcomesByThesis,
        outcomesByRegime,
        timingByThesis
      }, userId);
    }

    // Structured learned-context sink — runs IN PARALLEL with (does NOT gate or replace) the
    // reflection_summary write above, converting the opaque blob into per-row, attributable,
    // erasable FACTS over time. We emit only durable QUALITATIVE track-record facts (directional,
    // no numeric percent/size) for well-sampled theses; the fail-closed classifier drops anything
    // it deems risk-adjacent, and risk/sizing inferences are never written in this slice.
    await writeThesisTrackRecordFacts(outcomesByThesis, userId);
  } catch (error) {
    console.error("Failed to generate reflection summary:", error);
  }

  // Background: enrich closed lots with MAE/MFE and persist back to fill_events.
  // Runs unconditionally (no openaiKey required) in the background — never blocks
  // the reflection LLM call above, never called from any synchronous order path.
  persistExcursionsBackground(accountNumber, source, userId);
}

/**
 * Fire-and-forget: enrich closed lots with MAE/MFE excursions (async network
 * calls to Yahoo Finance) then write them back to fill_events so historical
 * analysis panels can read them without re-fetching on every page load.
 */
function persistExcursionsBackground(
  accountNumber: string,
  source: "paper" | "live",
  userId: string
): void {
  (async () => {
    try {
      const lots = getClosedLotsDetailed(accountNumber, source, userId);
      const enriched = await enrichClosedLotsWithExcursions(lots);
      for (const lot of enriched) {
        if (lot.mae !== undefined && lot.mfe !== undefined && lot.symbol && lot.exitAt) {
          upsertFillExcursionsByKey(accountNumber, lot.symbol, lot.exitAt, lot.mae, lot.mfe, userId);
        }
      }
    } catch (err) {
      console.error("persistExcursionsBackground failed:", err);
    }
  })();
}

function truncate(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Per-account internal-settings key for the reflection regeneration-gate signature. */
export function reflectionSignatureKey(userId: string, accountNumber: string): string {
  return `reflection_signature:${userId}:${accountNumber}`;
}

// ── Decomposed reflection lessons (2026-07-04 composite review A, [Both]) ─────
// The single <=130-word reflection blob is lossy, drift-prone, cache-busting, and regime-blind.
// These helpers decompose the realized record into DISCRETE tagged lesson rows — one per
// (thesisTag x regime) bucket with enough sample — stored in learned_context (regime/thesis_tag/
// dominant_factor columns) AND embedded as doc_type 'lesson' vectors carrying realized
// win-rate / MAE-MFE / capturePct, so decision-time retrieval (experience-memory's episodic pass
// consumes doc_type 'lesson'; retrieveLearnedContext boosts by regime/thesis) sees exactly the
// lesson relevant to today's regime instead of one opaque paragraph.

/** Minimum closed lots before a (thesis x regime) bucket emits a lesson row. */
export const MIN_LOTS_FOR_LESSON = 5;

export interface LessonBucket {
  thesisTag: string;
  /** null = regime-agnostic fallback lesson (thesis has sample, but every regime bucket is thin). */
  regime: string | null;
  /** Modal dominant entry factor across the bucket's lots (null when no lot carries one). */
  dominantFactor: string | null;
  trades: number;
  /** Realized win rate, 0-100. */
  winRatePct: number;
  avgReturnPct: number;
  /** Avg max adverse excursion (%) across lots with persisted MAE; undefined when none have it. */
  avgMaePct?: number;
  /** Avg max favorable excursion (%) across lots with persisted MFE; undefined when none have it. */
  avgMfePct?: number;
  /** Realized return as % of the favorable move (only when avgMfePct > 0). */
  capturePct?: number;
}

/**
 * Group closed lots into (thesisTag x regime) lesson buckets, gated on MIN_LOTS_FOR_LESSON.
 * Regime-agnostic fallback: a thesis whose TOTAL sample clears the gate but where NO single
 * regime bucket does emits one regime=null lesson instead — thin regimes still teach, they just
 * can't claim regime conditioning they don't have the sample for. Untagged lots never emit.
 */
export function buildLessonBuckets(lots: ClosedLot[]): LessonBucket[] {
  const byThesis = new Map<string, ClosedLot[]>();
  for (const lot of lots) {
    const thesis = lot.thesisTag?.trim();
    if (!thesis || thesis === "Untagged") continue;
    const list = byThesis.get(thesis) ?? [];
    list.push(lot);
    byThesis.set(thesis, list);
  }

  const buckets: LessonBucket[] = [];
  for (const [thesis, thesisLots] of byThesis) {
    const byRegime = new Map<string, ClosedLot[]>();
    for (const lot of thesisLots) {
      const regime = lot.regime?.trim() || "Unspecified";
      const list = byRegime.get(regime) ?? [];
      list.push(lot);
      byRegime.set(regime, list);
    }
    let emittedRegimeBucket = false;
    for (const [regime, regimeLots] of byRegime) {
      if (regimeLots.length < MIN_LOTS_FOR_LESSON || regime === "Unspecified") continue;
      buckets.push(bucketStats(thesis, regime, regimeLots));
      emittedRegimeBucket = true;
    }
    // Regime-agnostic fallback for thin regimes.
    if (!emittedRegimeBucket && thesisLots.length >= MIN_LOTS_FOR_LESSON) {
      buckets.push(bucketStats(thesis, null, thesisLots));
    }
  }
  return buckets;
}

function bucketStats(thesisTag: string, regime: string | null, lots: ClosedLot[]): LessonBucket {
  const wins = lots.filter((lot) => lot.pnl > 0).length;
  const avgReturnPct = lots.reduce((sum, lot) => sum + lot.returnPct, 0) / lots.length;
  const withMae = lots.filter((lot) => typeof lot.mae === "number");
  const withMfe = lots.filter((lot) => typeof lot.mfe === "number");
  const avgMaePct = withMae.length > 0 ? withMae.reduce((sum, lot) => sum + (lot.mae as number), 0) / withMae.length : undefined;
  const avgMfePct = withMfe.length > 0 ? withMfe.reduce((sum, lot) => sum + (lot.mfe as number), 0) / withMfe.length : undefined;
  const capturePct = avgMfePct !== undefined && avgMfePct > 0 ? (avgReturnPct / avgMfePct) * 100 : undefined;

  // Modal dominant factor across the bucket's lots.
  const factorCounts = new Map<string, number>();
  for (const lot of lots) {
    if (!lot.dominantFactor) continue;
    factorCounts.set(lot.dominantFactor, (factorCounts.get(lot.dominantFactor) ?? 0) + 1);
  }
  let dominantFactor: string | null = null;
  let best = 0;
  for (const [factor, count] of factorCounts) {
    if (count > best) {
      best = count;
      dominantFactor = factor;
    }
  }

  return {
    thesisTag,
    regime,
    dominantFactor,
    trades: lots.length,
    winRatePct: Math.round((wins / lots.length) * 100),
    avgReturnPct: Number(avgReturnPct.toFixed(2)),
    ...(avgMaePct !== undefined ? { avgMaePct: Number(avgMaePct.toFixed(2)) } : {}),
    ...(avgMfePct !== undefined ? { avgMfePct: Number(avgMfePct.toFixed(2)) } : {}),
    ...(capturePct !== undefined ? { capturePct: Number(capturePct.toFixed(1)) } : {})
  };
}

/** Stable learned_context subject for a lesson bucket — reconcile-on-write key. */
export function lessonSubject(bucket: Pick<LessonBucket, "thesisTag" | "regime">): string {
  return `lesson:${bucket.thesisTag}@${bucket.regime ?? "all-regimes"}`;
}

function lessonValue(bucket: LessonBucket): string {
  const where = bucket.regime ? `in the "${bucket.regime}" regime` : "across all regimes (no single regime has enough sample yet)";
  const timing =
    bucket.avgMaePct !== undefined && bucket.avgMfePct !== undefined
      ? ` Timing: avg MAE ${bucket.avgMaePct}%, avg MFE ${bucket.avgMfePct}%${bucket.capturePct !== undefined ? `, capture ${bucket.capturePct}% of the favorable move` : ""}.`
      : "";
  const factor = bucket.dominantFactor ? ` Dominant entry factor: ${bucket.dominantFactor}.` : "";
  return `Realized record for the "${bucket.thesisTag}" thesis ${where}: ${bucket.trades} closed lots, win rate ${bucket.winRatePct}%, avg return ${bucket.avgReturnPct}%.${timing}${factor}`;
}

/** Build the doc_type 'lesson' vector document for a lesson row. */
export function buildLessonDocument(row: LearnedContextRow, accountNumber: string): ContextDocument {
  return {
    text: [
      "Decomposed reflection lesson",
      `thesis_tag: ${row.thesisTag ?? "n/a"}`,
      `regime: ${row.regime ?? "all-regimes"}`,
      `dominant_factor: ${row.dominantFactor ?? "n/a"}`,
      row.value
    ].join("\n"),
    metadata: {
      symbol: "PORTFOLIO",
      source: "reflection-lesson",
      doc_type: "lesson",
      timestamp: row.assertedAt,
      accession: row.id,
      lesson_subject: row.subject,
      account_number: accountNumber,
      ...(row.thesisTag ? { thesis_tag: row.thesisTag } : {}),
      ...(row.regime ? { entry_market_regime: row.regime } : {}),
      ...(row.dominantFactor ? { dominant_factor: row.dominantFactor } : {})
    }
  };
}

export type LessonEmbedFn = (docs: ContextDocument[], userId: string) => Promise<unknown>;

/**
 * Write decomposed lesson rows into learned_context (reconcile-on-write: identical value → no-op,
 * changed value → supersede) AND embed each written/updated lesson as a doc_type 'lesson' vector.
 * Rows are written DIRECTLY (not through ingestLearned): these are deterministic system-computed
 * track-record statistics over the owner's own closed lots — the fail-closed classifier exists to
 * gate free-text LLM/chat output and would misread the numeric content as risk-adjacent. They are
 * fact-tier ADVISORY rows; nothing here feeds sizing or policy. `embed` is injectable for tests;
 * embedding failures never fail the write (vectors are additive, SQLite is the source of truth).
 */
export async function writeDecomposedLessons(
  userId: string,
  accountNumber: string,
  lots: ClosedLot[],
  opts: { embed?: LessonEmbedFn } = {}
): Promise<{ written: number; embedded: number }> {
  const buckets = buildLessonBuckets(lots);
  const nowIso = new Date().toISOString();
  const changed: LearnedContextRow[] = [];

  for (const bucket of buckets) {
    const subject = lessonSubject(bucket);
    const value = lessonValue(bucket);
    const existing = findLiveLearnedContextBySubject(userId, "pattern", subject, null);
    if (existing && existing.value === value) continue; // unchanged → no rewrite, no re-embed
    const row: LearnedContextRow = {
      id: randomUUID(),
      userId,
      scope: "private",
      kind: "pattern",
      subject,
      symbol: null,
      value,
      source: "inferred",
      origin: "autonomous",
      riskTier: "fact",
      confidence: 0.6,
      contributorUserId: userId,
      assertedAt: nowIso,
      supersededBy: null,
      expiresAt: null,
      regime: bucket.regime,
      thesisTag: bucket.thesisTag,
      dominantFactor: bucket.dominantFactor
    };
    insertLearnedContext(row);
    if (existing) supersedeLearnedContext(existing.id, row.id);
    audit(
      "reflection_lesson.write",
      {
        userId,
        accountNumber,
        subject,
        regime: bucket.regime,
        thesisTag: bucket.thesisTag,
        dominantFactor: bucket.dominantFactor,
        trades: bucket.trades,
        op: existing ? "supersede" : "append"
      },
      userId
    );
    changed.push(row);
  }

  let embedded = 0;
  if (changed.length > 0) {
    const embed: LessonEmbedFn =
      opts.embed ??
      (async (docs, embedUserId) => {
        const { storeContexts } = await import("./vector-db");
        return storeContexts(docs, embedUserId, { dedupKeyPrefix: "lesson" });
      });
    try {
      await embed(changed.map((row) => buildLessonDocument(row, accountNumber)), userId);
      embedded = changed.length;
    } catch (error) {
      console.warn("Lesson embedding failed (rows still persisted in learned_context):", error);
    }
  }

  return { written: changed.length, embedded };
}

/**
 * The reflection string for the Bull SYSTEM prompt. DEMOTION RULE (composite review A, [Both]):
 * once ANY structured lesson rows exist for this user, the free-text blob leaves the system
 * prompt — a short static pointer replaces it (cache-stable), and the lessons themselves reach
 * the model as tagged, regime-boosted learnedContext DATA rows. With ZERO structured lessons the
 * per-account blob remains the fallback so a young account still gets its reflection.
 */
export const REFLECTION_DEMOTED_NOTE =
  "Superseded by structured lessons: see the tagged track-record rows in learnedContext.";

export function resolveReflectionForPrompt(userId: string, accountNumber: string | undefined): string {
  try {
    if (countLiveLessonRows(userId) > 0) return REFLECTION_DEMOTED_NOTE;
    if (!accountNumber) return "";
    return getLatestReflectionVersion(userId, accountNumber)?.summary ?? "";
  } catch (error) {
    console.warn("resolveReflectionForPrompt failed:", error);
    return "";
  }
}

// Minimum closed lots before a thesis's realized record is durable enough to record as a fact.
const MIN_LOTS_FOR_TRACK_RECORD_FACT = 5;

/**
 * Emit durable, QUALITATIVE track-record facts per well-sampled thesis into learned_context
 * (origin='autonomous'). The phrasing is deliberately directional and carries NO numeric
 * percent/size token, so the fail-closed classifier admits it as a fact rather than dropping it
 * as a risk-adjacent (numeric) candidate. Untagged buckets are skipped. Best-effort: a failure
 * here never affects the reflection write or any trading path.
 */
async function writeThesisTrackRecordFacts(outcomesByThesis: ThesisStat[], userId: string): Promise<void> {
  for (const stat of outcomesByThesis) {
    if (!stat.thesisTag || stat.thesisTag === "Untagged") continue;
    if (stat.trades < MIN_LOTS_FOR_TRACK_RECORD_FACT) continue;
    const verdict = stat.shrunkAvgReturnPct > 0.5
      ? "has a positive realized track record"
      : stat.shrunkAvgReturnPct < -0.5
        ? "has repeatedly lost on a realized basis"
        : "has a roughly break-even realized track record";
    try {
      await ingestLearned(
        userId,
        {
          kind: "pattern",
          subject: `track_record:${stat.thesisTag}`,
          value: `The "${stat.thesisTag}" thesis ${verdict} across closed trades for this account.`,
          source: "inferred",
          confidence: 0.6
        },
        "autonomous"
      );
    } catch (error) {
      console.error("Failed to write thesis track-record fact:", error);
    }
  }
}
