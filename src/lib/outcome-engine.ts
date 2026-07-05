// outcome-engine.ts — THE OUTCOME WRITER (composite expert review §A, "the single most-blocked-on
// item"). A scheduled maturation job that finally writes SocraticDecisionCase.outcome:
//
//   placed decisions    -> joined to their fill_events entry basis and (when the lot has closed)
//                          the FIFO closed-lot realized P&L from performance.calculatePnl;
//   blocked/rejected    -> joined to the skipped-candidate counterfactual row inserted at
//   (incl. Bear vetoes)    veto/block/rejection time (refPrice basis), same pipeline as the
//                          missed-opportunity analytics;
//
// then measures the multi-horizon (15m/1h/1d/1w) forward returns (outcome-horizons.ts), writes
// outcome + measuredAt, emits a receipt per closed case, and triggers the vector-memory lifecycle
// re-index (writeSocraticDecisionOutcome). It piggybacks the counterfactual cadence: strategy.ts
// fires it right after materializeSkippedCandidateCounterfactuals on every run.
//
// When a case reaches a terminal outcome with real data, a budget-gated LLM post-mortem pass turns
// belief + dissent + evidence vs the realized outcome into 1-3 concrete lessons (direction:
// repeat/avoid/adjust-sizing/adjust-timing) plus {verdictOnBelief, whichDissentMattered}; lessons
// replace the creation-time template strings, re-index, and route through ingestLearned (origin
// 'autonomous'). No LLM key / over budget -> skipped WITH a receipt; the job itself never fails.
//
// Honesty contract: nothing here fabricates a price. Horizons that cannot be measured become
// terminal 'unresolvable' with a reason and stay in every denominator (coverage disclosure
// "N/M resolved (X%)" on the job receipt). Advisory throughout — this writes memory, never gates.
import {
  audit,
  getPolicy,
  getSkippedCounterfactualByRunSymbol,
  getSkippedCounterfactualCoverage,
  getSocraticOutcomeCoverage,
  listFillEvents,
  listFillEventsByProposalId,
  listSocraticDecisionCasesNeedingOutcome,
  writeSocraticDecisionLessons,
  writeSocraticDecisionOutcome
} from "./db";
import { fetchDailyOHLC } from "./history";
import type { OHLCBar } from "./indicators";
import { ingestLearned } from "./learned-context/store";
import { isOverLlmBudget } from "./llm-budget";
import { buildLlmRequestBody, extractLlmText, llmAuthHeaders } from "./llm-call";
import { humanizeLlmError } from "./llm-errors";
import { resolveLlmEndpoint } from "./llm-provider";
import { LLM_OUTPUT_TOKEN_CAPS, llmFetch } from "./llm-request";
import { extractLlmUsage, recordLlmUsage } from "./llm-usage";
import { addTradingDays } from "./market-calendar";
import { normalizeSymbol } from "./money";
import { withLlmGeneration } from "./observability";
import {
  closeAtOrAfter,
  computeDailyHorizonRows,
  computeIntradayHorizonRows,
  INTRADAY_HORIZONS,
  mergeHorizonRows,
  normalizeDailyBars,
  UNRESOLVABLE_AFTER_TRADING_DAYS,
  type NormalizedDailyBar
} from "./outcome-horizons";
import { calculatePnl, type ClosedLot } from "./performance";
import { summarizeOpenAiRequest, summarizeOpenAiResponseText } from "./telemetry-sanitize";
import type { FillEvent, SocraticDecisionCase, SocraticOutcomeHorizonRow } from "./types";

const DAY_MS = 86_400_000;
const DEFAULT_CASE_LIMIT = 25;
const DEFAULT_RECHECK_MS = 6 * 60 * 60_000;
const DEFAULT_LESSON_BATCH_CAP = 3;
const LESSON_DIRECTIONS = ["repeat", "avoid", "adjust-sizing", "adjust-timing"] as const;
type LessonDirection = (typeof LESSON_DIRECTIONS)[number];

export type OutcomeOHLCFetcher = (symbol: string, now?: number, userId?: string) => Promise<OHLCBar[] | null>;
/** Live-quote sampler for the 15m/1h forward-sampling windows. Return undefined when no quote. */
export type OutcomeQuoteFetcher = (symbol: string, userId?: string) => Promise<number | undefined>;
/** Test seam for the post-mortem LLM: gets the prompts, returns the raw model text (JSON). */
export type OutcomeLessonLlm = (input: { systemPrompt: string; userContent: string }) => Promise<string | undefined>;

export interface OutcomeEngineOptions {
  now?: number;
  /** Scope to one connected account's decision cases (job runs per-account off the strategy cadence). */
  connectedAccountId?: string;
  /** Max cases examined per run (oldest owed first). */
  limit?: number;
  /** Min gap before re-measuring a still-'open' case. */
  recheckMs?: number;
  /** Max LLM post-mortem passes per run (budget containment on top of the daily LLM budget gate). */
  lessonBatchCap?: number;
  fetchOHLC?: OutcomeOHLCFetcher;
  fetchQuote?: OutcomeQuoteFetcher;
  llm?: OutcomeLessonLlm;
}

export interface OutcomeEngineResult {
  scanned: number;
  /** Cases whose outcome object was written/refreshed this run (incl. still-'open' partials). */
  measured: number;
  /** Cases that reached a terminal outcome status this run (won/lost/flat/unknown/unresolvable). */
  closed: number;
  /** Subset of `closed` that terminated 'unresolvable' (counted, never dropped). */
  unresolvable: number;
  lessonsWritten: number;
  lessonsSkipped: number;
  /** "N/M resolved (X%)" disclosure across decision cases + skipped counterfactuals. */
  coverageDisclosure: string;
}

const TERMINAL_OUTCOME_STATUSES = new Set(["won", "lost", "flat", "unknown", "unresolvable"]);

/**
 * The scheduled maturation pass. Never throws for a single bad case; per-case failures are logged
 * and skipped so one delisted symbol cannot stall the whole ledger.
 */
export async function matureSocraticDecisionOutcomes(
  userId: string = "local",
  options: OutcomeEngineOptions = {}
): Promise<OutcomeEngineResult> {
  const now = options.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const nowDate = nowIso.slice(0, 10);
  const limit = boundedInteger(options.limit, 1, 200, DEFAULT_CASE_LIMIT);
  const recheckMs = boundedInteger(options.recheckMs, 60_000, 7 * DAY_MS, DEFAULT_RECHECK_MS);
  const lessonBatchCap = boundedInteger(options.lessonBatchCap, 0, 20, DEFAULT_LESSON_BATCH_CAP);
  const fetchOHLC = options.fetchOHLC ?? fetchDailyOHLC;
  const fetchQuote = options.fetchQuote ?? defaultQuoteFetcher;

  const cases = listSocraticDecisionCasesNeedingOutcome(userId, {
    limit,
    measuredBefore: new Date(now - recheckMs).toISOString(),
    connectedAccountId: options.connectedAccountId
  });

  const barsCache = new Map<string, NormalizedDailyBar[] | null>();
  const getBars = async (symbol: string): Promise<NormalizedDailyBar[] | null> => {
    const key = normalizeSymbol(symbol);
    if (barsCache.has(key)) return barsCache.get(key) ?? null;
    const raw = await fetchOHLC(key, now, userId).catch(() => null);
    const bars = raw ? normalizeDailyBars(raw) : null;
    barsCache.set(key, bars);
    return bars;
  };
  const spyBars = cases.length > 0 ? (await getBars("SPY")) ?? [] : [];

  let measured = 0;
  let closed = 0;
  let unresolvable = 0;
  const newlyClosed: SocraticDecisionCase[] = [];

  for (const decisionCase of cases) {
    try {
      const outcome = await measureCase(decisionCase, { userId, now, nowIso, nowDate, getBars, spyBars, fetchQuote });
      if (!outcome) continue; // nothing decidable yet (e.g. awaiting fill reconciliation)
      const updated = await writeSocraticDecisionOutcome(decisionCase.id, outcome, userId);
      measured += 1;
      if (TERMINAL_OUTCOME_STATUSES.has(outcome.status)) {
        closed += 1;
        if (outcome.status === "unresolvable") unresolvable += 1;
        if (updated) newlyClosed.push(updated);
      }
    } catch (err) {
      console.warn(
        `[outcome-engine] failed to measure case ${decisionCase.id} (${decisionCase.symbol ?? "?"}):`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ── Per-decision post-mortem lessons (budget-gated, batch-capped, receipt on every skip) ──────
  let lessonsWritten = 0;
  let lessonsSkipped = 0;
  const lessonCandidates = newlyClosed.filter(
    (c) => c.outcome && c.outcome.status !== "unresolvable" && c.outcome.outcomes.some((row) => row.resolution === "ok")
  );
  if (lessonCandidates.length > 0 && isOverLlmBudget(userId, options.connectedAccountId)) {
    lessonsSkipped = lessonCandidates.length;
    audit(
      "socratic_lessons_skipped",
      { reason: "over_llm_budget", decisionIds: lessonCandidates.map((c) => c.id) },
      userId,
      options.connectedAccountId
    );
  } else if (lessonCandidates.length > 0) {
    let index = 0;
    for (; index < Math.min(lessonCandidates.length, lessonBatchCap); index += 1) {
      const candidate = lessonCandidates[index];
      const result = await generatePostMortemLessons(candidate, userId, options.llm).catch((err) => {
        console.warn("[outcome-engine] post-mortem lesson pass failed:", err instanceof Error ? err.message : String(err));
        return { written: false, skippedReason: "llm_error" as string | undefined };
      });
      if (result.written) {
        lessonsWritten += 1;
        continue;
      }
      lessonsSkipped += 1;
      audit(
        "socratic_lessons_skipped",
        { reason: result.skippedReason ?? "unknown", decisionIds: [candidate.id] },
        userId,
        options.connectedAccountId
      );
      // No key configured -> every remaining candidate skips identically; receipt once, no retries.
      if (result.skippedReason === "no_llm_key") {
        const rest = lessonCandidates.slice(index + 1);
        if (rest.length > 0) {
          lessonsSkipped += rest.length;
          audit(
            "socratic_lessons_skipped",
            { reason: "no_llm_key", decisionIds: rest.map((c) => c.id) },
            userId,
            options.connectedAccountId
          );
        }
        index = lessonCandidates.length;
        break;
      }
    }
    // Batch cap containment: candidates beyond the per-run cap wait for the next cadence run —
    // receipted so the deferral is visible, not silent.
    const deferred = lessonCandidates.slice(Math.max(index, lessonBatchCap));
    if (index < lessonCandidates.length && deferred.length > 0) {
      lessonsSkipped += deferred.length;
      audit(
        "socratic_lessons_skipped",
        { reason: "batch_cap", decisionIds: deferred.map((c) => c.id) },
        userId,
        options.connectedAccountId
      );
    }
  }

  const decisionCoverage = getSocraticOutcomeCoverage(userId, options.connectedAccountId);
  const counterfactualCoverage = getSkippedCounterfactualCoverage(userId, options.connectedAccountId);
  const coverageDisclosure = `decisions: ${decisionCoverage.disclosure}; skipped counterfactuals: ${counterfactualCoverage.disclosure}`;

  // Job-level maturation receipt (the per-case receipts are emitted inside writeSocraticDecisionOutcome).
  audit(
    "socratic_outcome_job",
    { scanned: cases.length, measured, closed, unresolvable, lessonsWritten, lessonsSkipped, coverage: coverageDisclosure },
    userId,
    options.connectedAccountId
  );

  return { scanned: cases.length, measured, closed, unresolvable, lessonsWritten, lessonsSkipped, coverageDisclosure };
}

// ── Case measurement ──────────────────────────────────────────────────────────────────────────

interface MeasureContext {
  userId: string;
  now: number;
  nowIso: string;
  nowDate: string;
  getBars: (symbol: string) => Promise<NormalizedDailyBar[] | null>;
  spyBars: NormalizedDailyBar[];
  fetchQuote: OutcomeQuoteFetcher;
}

async function measureCase(
  decisionCase: SocraticDecisionCase,
  ctx: MeasureContext
): Promise<NonNullable<SocraticDecisionCase["outcome"]> | undefined> {
  const symbol = decisionCase.symbol ? normalizeSymbol(decisionCase.symbol) : undefined;
  if (!symbol) return undefined; // portfolio-level cases have no per-symbol forward path (yet)

  // 1) Resolve the entry basis (real prices only; provenance recorded in priceBasis).
  let basisPrice: number | undefined;
  let basisAtMs: number | undefined;
  let priceBasisPrefix = "ref_price";
  let realizedLot: ClosedLot | undefined;
  let note: string | undefined;

  if (decisionCase.status === "placed") {
    const fills = listFillEventsByProposalId(decisionCase.proposalId ?? decisionCase.id, ctx.userId).filter(
      (fill) => normalizeSymbol(fill.symbol) === symbol
    );
    const entryFill = fills[0];
    if (entryFill && entryFill.price > 0) {
      basisPrice = entryFill.price;
      basisAtMs = Date.parse(entryFill.filledAt);
      priceBasisPrefix = "fill";
      realizedLot = findRealizedLot(entryFill, ctx.userId);
      note = realizedLot
        ? "Realized from the FIFO closed lot opened by this decision's fill."
        : "Position still open; horizon returns measured from the entry fill.";
    } else {
      // Placed but no usable fill row: wait for reconciliation inside the bounded window, then be
      // honest that the join is impossible rather than pending forever.
      const unresolvableAfter = addTradingDays(decisionCase.createdAt.slice(0, 10), UNRESOLVABLE_AFTER_TRADING_DAYS);
      if (ctx.nowDate > unresolvableAfter) {
        return {
          status: "unresolvable",
          note: "No fill event ever joined this placed decision (no entry basis).",
          measuredAt: ctx.nowIso,
          outcomes: mergeHorizonRows(decisionCase.outcome?.outcomes, [])
        };
      }
      return undefined;
    }
  } else {
    // blocked / rejected (incl. Bear vetoes) -> counterfactual forward return from refPrice.
    const counterfactual =
      decisionCase.runId ? getSkippedCounterfactualByRunSymbol(ctx.userId, decisionCase.runId, symbol) : undefined;
    if (counterfactual) {
      basisPrice = counterfactual.refPrice;
      basisAtMs = Date.parse(counterfactual.snapshotAt);
      priceBasisPrefix = "ref_price";
    } else {
      // No counterfactual row (older decisions predate the veto/block insert): fall back to the
      // decision day's daily close as the basis — a real price with its provenance disclosed.
      const bars = await ctx.getBars(symbol);
      const createdDate = decisionCase.createdAt.slice(0, 10);
      const entryBar = bars ? closeAtOrAfter(bars, createdDate) : undefined;
      if (entryBar) {
        basisPrice = entryBar.close;
        basisAtMs = Date.parse(decisionCase.createdAt);
        priceBasisPrefix = `decision_day_close(${entryBar.date})`;
      } else {
        const unresolvableAfter = addTradingDays(createdDate, UNRESOLVABLE_AFTER_TRADING_DAYS);
        if (ctx.nowDate > unresolvableAfter) {
          return {
            status: "unresolvable",
            note: "No counterfactual row and no price series for the decision window.",
            measuredAt: ctx.nowIso,
            outcomes: mergeHorizonRows(decisionCase.outcome?.outcomes, [])
          };
        }
        return undefined;
      }
    }
    note = "Counterfactual — this decision was not executed; returns are hypothetical forward moves from the reference price.";
  }

  if (!basisPrice || !Number.isFinite(basisAtMs ?? NaN)) return undefined;
  const basisAt = basisAtMs as number;

  // 2) Intraday horizons: sample a live quote ONLY when a 15m/1h window is currently open and not
  //    already terminal — the cheap sampling path. Missed windows terminate honestly.
  const existingTerminal = new Set(
    (decisionCase.outcome?.outcomes ?? []).map((row) => row.horizon)
  );
  const elapsedMs = ctx.now - basisAt;
  const samplableNow = INTRADAY_HORIZONS.some(
    ({ horizon, ms, toleranceMs }) => !existingTerminal.has(horizon) && elapsedMs >= ms && elapsedMs <= ms + toleranceMs
  );
  const quotePrice = samplableNow ? await ctx.fetchQuote(symbol, ctx.userId).catch(() => undefined) : undefined;
  const intradayRows = computeIntradayHorizonRows({
    basisPrice,
    basisAtMs: basisAt,
    side: decisionCase.side,
    nowMs: ctx.now,
    quotePrice,
    priceBasisPrefix,
    measuredAt: ctx.nowIso
  });

  // 3) Daily horizons from the cascade's daily closes, SPY-relative.
  const bars = await ctx.getBars(symbol);
  const dailyRows = computeDailyHorizonRows({
    basisPrice,
    basisDate: new Date(basisAt).toISOString().slice(0, 10),
    side: decisionCase.side,
    bars,
    spyBars: ctx.spyBars,
    nowDate: ctx.nowDate,
    priceBasisPrefix,
    measuredAt: ctx.nowIso
  });

  const outcomes = mergeHorizonRows(decisionCase.outcome?.outcomes, [...intradayRows, ...dailyRows]);

  // 4) Case-level verdict.
  if (realizedLot) {
    return {
      status: realizedLot.pnl > 0 ? "won" : realizedLot.pnl < 0 ? "lost" : "flat",
      returnPct: realizedLot.returnPct,
      pnlUsd: Number(realizedLot.pnl.toFixed(2)),
      note,
      measuredAt: ctx.nowIso,
      outcomes
    };
  }

  const allHorizonsTerminal = outcomes.length === 4;
  const okRows = outcomes.filter((row) => row.resolution === "ok");
  if (decisionCase.status !== "placed" && allHorizonsTerminal) {
    const headline = pickHeadlineRow(okRows);
    if (headline && typeof headline.returnPct === "number") {
      return {
        status: headline.returnPct > 0 ? "won" : headline.returnPct < 0 ? "lost" : "flat",
        returnPct: headline.returnPct,
        note: `${note} Headline horizon: ${headline.horizon}.`,
        measuredAt: ctx.nowIso,
        outcomes
      };
    }
    return {
      status: "unresolvable",
      note: `${note} No horizon could be measured (${outcomes.map((row) => `${row.horizon}:${row.reason ?? "?"}`).join(", ")}).`,
      measuredAt: ctx.nowIso,
      outcomes
    };
  }

  // Still maturing (placed-with-open-lot, or horizons not yet due): write the partial ledger so the
  // memory doc reflects everything measured so far; the job re-visits after recheckMs.
  return { status: "open", note, measuredAt: ctx.nowIso, outcomes };
}

/** Longest resolved horizon wins the headline: 1w > 1d > 1h > 15m. */
function pickHeadlineRow(okRows: SocraticOutcomeHorizonRow[]): SocraticOutcomeHorizonRow | undefined {
  const priority: Array<SocraticOutcomeHorizonRow["horizon"]> = ["1w", "1d", "1h", "15m"];
  for (const horizon of priority) {
    const row = okRows.find((r) => r.horizon === horizon);
    if (row) return row;
  }
  return undefined;
}

/** FIFO closed lot opened by this exact fill (symbol + entry timestamp join), if the lot closed. */
function findRealizedLot(entryFill: FillEvent, userId: string): ClosedLot | undefined {
  try {
    const fills = listFillEvents(entryFill.accountNumber, entryFill.source, 500, userId);
    const { closedLots } = calculatePnl(fills);
    return closedLots.find(
      (lot) => normalizeSymbol(lot.symbol ?? "") === normalizeSymbol(entryFill.symbol) && lot.entryAt === entryFill.filledAt
    );
  } catch {
    return undefined;
  }
}

const defaultQuoteFetcher: OutcomeQuoteFetcher = async (symbol) => {
  try {
    const { fetchYahooFinanceQuote } = await import("./yahoo-finance");
    const quote = await fetchYahooFinanceQuote(normalizeSymbol(symbol));
    return quote && quote.price > 0 ? quote.price : undefined;
  } catch {
    return undefined;
  }
};

// ── Post-mortem lessons ───────────────────────────────────────────────────────────────────────

interface LessonPassResult {
  written: boolean;
  skippedReason?: string;
}

const LESSON_SYSTEM_PROMPT = `You are the per-decision Post-Mortem Engine for a Socratic trading agent.
You receive ONE closed decision case: the original belief (thesis + rationale), the dissent raised against it (Red Team / policy counterarguments), the evidence used, and the REALIZED multi-horizon outcome (15m/1h/1d/1w returns, SPY-relative where available; 'unresolvable' horizons could not be measured — never treat them as zero).
Judge the belief against what actually happened and extract 1-3 CONCRETE lessons. Do not restate the outcome; each lesson must be an actionable behavioral adjustment. Avoid numeric position-size or percent prescriptions — direction words only.
Respond with STRICT JSON only (no markdown, no prose outside the JSON):
{"lessons":[{"lesson":"<one concrete sentence>","direction":"repeat|avoid|adjust-sizing|adjust-timing"}],"verdictOnBelief":"<one sentence: was the original belief right, wrong, or right-for-the-wrong-reason?>","whichDissentMattered":"<one sentence: which recorded dissent, if any, proved material — or 'none'>"}`;

async function generatePostMortemLessons(
  decisionCase: SocraticDecisionCase,
  userId: string,
  llmOverride?: OutcomeLessonLlm
): Promise<LessonPassResult> {
  const outcome = decisionCase.outcome;
  if (!outcome) return { written: false, skippedReason: "no_outcome" };

  const userContent = JSON.stringify({
    symbol: decisionCase.symbol,
    side: decisionCase.side,
    status: decisionCase.status,
    action: decisionCase.action,
    thesisTag: decisionCase.thesisTag,
    regime: decisionCase.regime,
    confidenceScore: decisionCase.confidenceScore,
    belief: { thesis: decisionCase.thesis, rationale: truncate(decisionCase.rationale, 900) },
    dissent: decisionCase.dissent.slice(0, 6).map((item) => ({ title: item.title, summary: truncate(item.summary, 300) })),
    evidence: decisionCase.evidence.slice(0, 6).map((item) => ({ kind: item.kind, title: item.title, summary: truncate(item.summary, 300) })),
    coachNotes: decisionCase.coachNotes.slice(-5),
    realizedOutcome: outcome
  });

  const text = llmOverride
    ? await llmOverride({ systemPrompt: LESSON_SYSTEM_PROMPT, userContent })
    : await callLessonLlm(userId, userContent);
  if (text === undefined) return { written: false, skippedReason: llmOverride ? "llm_empty" : "no_llm_key" };

  const parsed = parseLessonResponse(text);
  if (!parsed || parsed.lessons.length === 0) return { written: false, skippedReason: "unparseable_llm_response" };

  const lessonLines = parsed.lessons.map(({ lesson, direction }) => `(${direction}) ${lesson}`);
  const lessons = [
    ...lessonLines,
    `Belief verdict: ${parsed.verdictOnBelief}`,
    `Decisive dissent: ${parsed.whichDissentMattered}`
  ];
  await writeSocraticDecisionLessons(decisionCase.id, lessons, userId);

  audit(
    "socratic_decision_postmortem",
    {
      decisionId: decisionCase.id,
      symbol: decisionCase.symbol,
      lessons: parsed.lessons,
      verdictOnBelief: parsed.verdictOnBelief,
      whichDissentMattered: parsed.whichDissentMattered,
      outcomeStatus: outcome.status
    },
    userId,
    decisionCase.connectedAccountId
  );

  // Route each lesson through the shared learned-context ingestion (origin 'autonomous'): the
  // fail-closed classifier decides fact-vs-risk tier; risk-tier lessons land in the approval inbox.
  for (const { lesson, direction } of parsed.lessons) {
    try {
      await ingestLearned(
        userId,
        {
          kind: "decision",
          subject: `decision_lesson:${decisionCase.symbol ?? "portfolio"}:${decisionCase.thesisTag ?? "untagged"}`,
          value: `${lesson} (direction: ${direction}; from the ${decisionCase.symbol ?? "portfolio"} ${decisionCase.status} decision, outcome ${outcome.status})`,
          symbol: decisionCase.symbol,
          source: "inferred",
          confidence: 0.55
        },
        "autonomous"
      );
    } catch (err) {
      console.warn("[outcome-engine] ingestLearned for lesson failed:", err instanceof Error ? err.message : String(err));
    }
  }

  return { written: true };
}

/**
 * Real LLM call (same plumbing as post-mortem.ts). Returns undefined when no key is configured.
 *
 * INTENTIONALLY EXEMPT from strategy.ts's run-scoped usage-budget model downgrade: this job runs
 * fire-and-forget, detached from any single `runStrategyOnce` call's lifetime (it matures cases
 * across accounts/runs and can still be in flight after the triggering run returns), so there is no
 * single well-defined "this run's downgrade" to hand it. It always re-reads the owner's persisted
 * (undowngraded) policy — same behavior as before the usage-budget downgrade existed.
 */
async function callLessonLlm(userId: string, userContent: string): Promise<string | undefined> {
  const policy = getPolicy(userId);
  const { url, key, model, provider, keySource, keyRef, transport } = resolveLlmEndpoint(
    policy,
    userId,
    "https://api.openai.com/v1/chat/completions"
  );
  if (!key) return undefined;

  const body = buildLlmRequestBody(
    { provider, transport },
    {
      model,
      systemPrompt: LESSON_SYSTEM_PROMPT,
      userContent,
      maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.postMortemReflection,
      reasoningEffort: policy.llmReasoningEffort
    }
  );

  const traced = await withLlmGeneration(
    {
      name: "trading.outcome-engine.postmortem",
      model,
      userId,
      input: summarizeOpenAiRequest(body),
      metadata: { endpoint: url, transport },
      tags: ["outcome-engine", "post-mortem"],
      output: (result: { text?: string }) => summarizeOpenAiResponseText(result.text)
    },
    async () => {
      const response = await llmFetch(url, {
        method: "POST",
        headers: llmAuthHeaders({ provider, key }),
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        console.warn(
          "[outcome-engine] post-mortem LLM call failed:",
          humanizeLlmError(await response.text().catch(() => ""), { provider, status: response.status })
        );
        return { text: undefined };
      }
      const payload = await response.json();
      recordLlmUsage({ userId, provider, model, context: "outcome-postmortem", keySource, keyRef, ...extractLlmUsage(payload) });
      const text = extractLlmText(payload);
      return { text: typeof text === "string" ? text : undefined };
    }
  );
  return traced.text;
}

interface ParsedLessonResponse {
  lessons: Array<{ lesson: string; direction: LessonDirection }>;
  verdictOnBelief: string;
  whichDissentMattered: string;
}

function parseLessonResponse(text: string): ParsedLessonResponse | undefined {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as { lessons?: unknown; verdictOnBelief?: unknown; whichDissentMattered?: unknown };
  const lessons = Array.isArray(obj.lessons)
    ? obj.lessons
        .map((entry) => {
          const item = entry as { lesson?: unknown; direction?: unknown };
          const lesson = typeof item.lesson === "string" ? item.lesson.trim() : "";
          const direction = LESSON_DIRECTIONS.find((d) => d === item.direction);
          return lesson && direction ? { lesson, direction } : undefined;
        })
        .filter((entry): entry is { lesson: string; direction: LessonDirection } => Boolean(entry))
        .slice(0, 3)
    : [];
  return {
    lessons,
    verdictOnBelief: typeof obj.verdictOnBelief === "string" && obj.verdictOnBelief.trim() ? obj.verdictOnBelief.trim() : "not stated",
    whichDissentMattered:
      typeof obj.whichDissentMattered === "string" && obj.whichDissentMattered.trim() ? obj.whichDissentMattered.trim() : "none"
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}
