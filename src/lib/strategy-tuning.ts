import {
  getPolicy,
  getStrategyPrompt,
  getActiveConnectedAccount,
  latestAuditByKind,
  listFillEvents,
  listStrategyRuns,
  resolveLlmCredential
} from "./db";
import { recordLlmUsage, extractLlmUsage } from "./llm-usage";
import { deriveExecutionState, llmExecutionMode, llmFillSource, llmModeClarification, type ExecutionState } from "./execution-mode";
import { symbolsForPolicyUniverse } from "./index-universes";
import { LLM_OUTPUT_TOKEN_CAPS, withLlmRequestBounds, type OpenAiTransport } from "./llm-request";
import { fetchMacroData } from "./macro";
import { withLlmGeneration } from "./observability";
import { getClosedLotCount, getPerformanceSummary, getSkippedCandidateReturns, MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT } from "./performance";
import { summarizeOpenAiRequest, summarizeOpenAiResponseText } from "./telemetry-sanitize";
import type {
  FillEvent,
  MarketScan,
  PerformanceSummary,
  ScoringWeights,
  StrategyTuningPatch,
  StrategyTuningProposal,
  TradingPolicy
} from "./types";

type LatestDecisionPayload = {
  summary?: string;
  marketScan?: MarketScan;
  proposals?: Array<{ proposal?: { symbol?: string; side?: string; rationale?: string }; status?: string; reasons?: string[] }>;
};

type NullableScoringWeights = Record<keyof ScoringWeights, number | null>;

type LlmTuningPayload = {
  summary: string;
  rationale: string;
  marketContext: string;
  performanceReadout: string;
  proposedPrompt: string;
  scoringWeights: NullableScoringWeights;
  policy: {
    maxOrderNotional: number | null;
    maxOrderPctOfNav: number | null;
    maxDailyNotional: number | null;
    maxSymbolExposurePct: number | null;
    maxGrossExposurePct: number | null;
    maxNetExposurePct: number | null;
    maxDailyOrders: number | null;
    maxProposalsPerRun: number | null;
    runCadenceMinutes: number | null;
    strategyAuthority: TradingPolicy["strategyAuthority"] | null;
    runDuringExtendedHours: boolean | null;
  };
  riskRules: {
    stopLossPct: number | null;
    takeProfitPct: number | null;
    trailingStopPct: number | null;
  };
  cautions: string[];
  confidenceScore: number;
};

/** A skipped candidate's realized outcome, as needed to reason about factor weighting. */
export interface MissedOpportunityInput {
  symbol: string;
  returnPct: number;
  score?: number;
  sector?: string;
  regime?: string;
  dominantFactor?: string;
  ageDays?: number;
}

export interface MissedOpportunitySummary {
  items: Array<{ symbol: string; returnPct: number; score?: number; sector?: string; regime?: string; dominantFactor?: string; ageDays?: number }>;
  /** Count of positive-return skipped names in the window. */
  count: number;
  /** The dominant factor that recurred across >= 2 missed winners, if any. */
  recurringFactor?: string;
  recurringFactorCount?: number;
}

/**
 * Compact matured "missed opportunity" evidence for the auto-tuner: high-scoring
 * candidates the strategy SKIPPED that subsequently rose over their horizon. When one
 * dominant factor keeps showing up among the missed winners, the tuner can weigh whether
 * the current `scoringWeights` under-weight that factor — still gated by the closed-lot
 * sample-size guardrail before any weight actually changes. Pure (no I/O) so it is unit
 * testable; callers pass already-sorted rows from `getSkippedCandidateReturns`.
 */
export function summarizeMissedOpportunities(rows: MissedOpportunityInput[], limit = 8): MissedOpportunitySummary {
  const winners = rows.filter((row) => typeof row.returnPct === "number" && row.returnPct > 0);
  const factorCounts = new Map<string, number>();
  for (const row of winners) {
    if (row.dominantFactor) factorCounts.set(row.dominantFactor, (factorCounts.get(row.dominantFactor) ?? 0) + 1);
  }
  let recurringFactor: string | undefined;
  let recurringFactorCount = 0;
  for (const [factor, count] of factorCounts) {
    if (count > recurringFactorCount) {
      recurringFactor = factor;
      recurringFactorCount = count;
    }
  }
  const items = winners.slice(0, limit).map((row) => ({
    symbol: row.symbol,
    returnPct: row.returnPct,
    ...(typeof row.score === "number" ? { score: row.score } : {}),
    ...(row.sector ? { sector: row.sector } : {}),
    ...(row.regime ? { regime: row.regime } : {}),
    ...(row.dominantFactor ? { dominantFactor: row.dominantFactor } : {}),
    ...(typeof row.ageDays === "number" ? { ageDays: row.ageDays } : {})
  }));
  return {
    items,
    count: winners.length,
    ...(recurringFactor && recurringFactorCount >= 2 ? { recurringFactor, recurringFactorCount } : {})
  };
}

export async function proposeStrategyTuning(userId: string = "local"): Promise<StrategyTuningProposal> {
  const policy = getPolicy(userId);
  const activeAccount = getActiveConnectedAccount(userId);
  const executionState = deriveExecutionState(policy, activeAccount);
  const prompt = getStrategyPrompt(userId);
  const latestDecision = latestAuditByKind("strategy_run", userId)?.payload as LatestDecisionPayload | undefined;
  const macro = await fetchMacroData(userId);
  const accountNumber = policy.accountNumber;
  const performance = accountNumber ? getPerformanceSummary(accountNumber, {}, userId) : undefined;
  const source = executionState.usesLocalSimulation ? "paper" : "live";
  const fills = accountNumber ? listFillEvents(accountNumber, source, 30, userId) : [];
  const closedLotCount = accountNumber ? getClosedLotCount(accountNumber, source, userId) : 0;
  const minLotsForWeights = policy.tuning?.minClosedLotsForWeightShift ?? MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT;
  const runs = listStrategyRuns(10, userId);
  // Matured skipped-candidate counterfactuals (empty price map => realized rows only,
  // no live quotes needed). Lets the tuner learn from high-scoring names it passed on.
  const missedOpportunities = summarizeMissedOpportunities(
    getSkippedCandidateReturns({}, userId, { limit: 12, maxAgeDays: 30 })
  );
  const executionMode = llmExecutionMode(executionState);
  const context = {
    currentDate: new Date().toISOString(),
    activeMode: executionMode,
    activeModeClarification: llmModeClarification(executionState),
    accountConfigured: Boolean(accountNumber),
    policy: compactPolicy(policy, executionState),
    strategyPrompt: prompt,
    performance: compactPerformance(performance, executionState.usesLocalSimulation),
    closedLotCount,
    minClosedLotsForWeightShift: minLotsForWeights,
    recentFills: fills.slice(0, 20).map((fill) => compactFill(fill, executionState)),
    recentRuns: runs.map((run) => ({
      startedAt: run.startedAt,
      status: run.status,
      totalCount: run.totalCount,
      placedCount: run.placedCount,
      testLocalCount: run.paperCount,
      proposedCount: run.proposedCount,
      blockedCount: run.blockedCount,
      summary: run.summary
    })),
    latestDecision: latestDecision
      ? {
          summary: latestDecision.summary,
          marketScan: compactMarketScan(latestDecision.marketScan),
          proposals: latestDecision.proposals?.map((item) => ({
            symbol: item.proposal?.symbol,
            side: item.proposal?.side,
            status: item.status,
            reasons: item.reasons,
            rationale: item.proposal?.rationale
          }))
        }
      : undefined,
    ...(missedOpportunities.count > 0 ? { missedOpportunities } : {}),
    macro
  };

  const cred = resolveLlmCredential("openai", userId);
  const openaiKey = cred.key;
  if (!openaiKey) {
    return localRulesProposal({ policy, prompt, performance, fills, latestDecision, closedLotCount, missedOpportunities });
  }

  const payload = await requestLlmTuning(context, openaiKey, userId, cred.source === "operator" ? "operator" : "user");
  const proposedPatch = toPatch(payload, prompt);
  const cautions = [...payload.cautions];
  // Hard-enforce the §3.E sample-size guardrail: the system prompt asks the model to
  // null factor weights below the gate, but never trust prose for a safety rule —
  // strip any weight changes it returned anyway when the closed-lot sample is too thin.
  if (closedLotCount < minLotsForWeights && proposedPatch.scoringWeights && Object.keys(proposedPatch.scoringWeights).length > 0) {
    delete proposedPatch.scoringWeights;
    cautions.push(`Withheld model-proposed factor-weight changes: only ${closedLotCount}/${minLotsForWeights} closed lots (insufficient evidence).`);
  }
  return {
    summary: payload.summary,
    rationale: payload.rationale,
    marketContext: payload.marketContext,
    performanceReadout: payload.performanceReadout,
    proposedPatch,
    cautions,
    confidenceScore: clamp(payload.confidenceScore, 0, 100),
    generatedBy: "llm"
  };
}

function compactPolicy(policy: TradingPolicy, executionState: ExecutionState) {
  return {
    systemState: policy.systemState,
    executionMode: llmExecutionMode(executionState),
    executionModeClarification: llmModeClarification(executionState),
    includedIndices: policy.includedIndices,
    additionalWatchlistCount: policy.additionalSymbols.length,
    ignoredSymbolCount: policy.blocklist?.length ?? 0,
    allowedCount: symbolsForPolicyUniverse(policy).length,
    strategyAuthority: policy.strategyAuthority,
    maxOrderNotional: policy.maxOrderNotional,
    maxDailyNotional: policy.maxDailyNotional,
    maxSymbolExposurePct: policy.maxSymbolExposurePct,
    maxDailyOrders: policy.maxDailyOrders,
    maxProposalsPerRun: policy.maxProposalsPerRun,
    runCadenceMinutes: policy.runCadenceMinutes,
    runDuringExtendedHours: policy.runDuringExtendedHours,
    scoringWeights: policy.scoringWeights,
    riskRules: policy.riskRules,
    sectorCaps: policy.sectorCaps
  };
}

function compactPerformance(performance: PerformanceSummary | undefined, paperMode: boolean) {
  if (!performance) return undefined;
  return {
    realizedPnl: paperMode ? performance.paperRealizedPnl : performance.liveRealizedPnl,
    unrealizedPnl: paperMode ? performance.paperUnrealizedPnl : performance.liveUnrealizedPnl,
    winRate: paperMode ? performance.paperWinRate : performance.liveWinRate,
    averageReturnPct: paperMode ? performance.paperAverageReturnPct : performance.liveAverageReturnPct,
    fillCount: performance.fills.length,
    recentAttribution: performance.attribution.slice(-8)
  };
}

function compactFill(fill: FillEvent, executionState: ExecutionState) {
  return {
    filledAt: fill.filledAt,
    source: llmFillSource(fill.source, executionState),
    symbol: fill.symbol,
    side: fill.side,
    quantity: fill.quantity,
    price: fill.price,
    notional: fill.notional,
    status: fill.status
  };
}

function compactMarketScan(scan?: MarketScan) {
  if (!scan) return undefined;
  return {
    source: scan.source,
    generatedAt: scan.generatedAt,
    scannedSymbols: scan.scannedSymbols,
    returnedQuotes: scan.returnedQuotes,
    warnings: scan.warnings,
    topCandidates: scan.topCandidates.slice(0, 10).map((quote, index) => ({
      rank: index + 1,
      symbol: quote.symbol,
      price: quote.price,
      intradayChangePct: quote.intradayChangePct,
      volume: quote.volume,
      marketCap: quote.marketCap,
      peRatio: quote.peRatio,
      sentiment: quote.sentiment,
      analystRating: quote.analystRating,
      sector: quote.sector,
      score: quote.score,
      factorBreakdown: quote.factorBreakdown
    }))
  };
}

async function requestLlmTuning(context: unknown, openaiKey: string, userId: string, keySource: "user" | "operator"): Promise<LlmTuningPayload> {
  const url = process.env.OPENAI_API_URL || "https://api.openai.com/v1/responses";
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const isChatCompletions = url.includes("/chat/completions");
  const transport: OpenAiTransport = isChatCompletions ? "chat-completions" : "responses";
  const schema = tuningSchema();
  const systemPrompt = [
    "You are the strategy improvement reviewer for an agentic equity trading dashboard.",
    "Review recent test/local vs live performance, latest market scan context, macro context, current risk policy, scoring weights, and the current strategy prompt.",
    "test/local is the app's local simulator backed by local account state and simulated fills. It is not Alpaca Paper or any broker-hosted paper trading account.",
    "Suggest conservative improvements that can be manually reviewed before being applied.",
    "Do not propose placing trades. Do not remove explicit safety controls.",
    `Sample-size guardrail: only propose scoringWeights (factor weight) changes when closedLotCount >= minClosedLotsForWeightShift (${MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT} closed lots). Below that the realized sample is too thin to attribute P&L to factors — set EVERY scoringWeights field to null and instead focus on prompt clarity and risk sizing, noting the small sample in cautions.`,
    "`missedOpportunities` (when present): high-scoring candidates the strategy SKIPPED that then rose over their horizon — each with realized returnPct, score, sector, regime, and dominantFactor; `recurringFactor` flags a factor that dominated multiple missed winners. If it appears, weigh whether scoringWeights under-weight that factor, but still obey the sample-size guardrail above before changing any weight.",
    "Return strict JSON only."
  ].join("\n");

  const body = withLlmRequestBounds(
    isChatCompletions
      ? {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(context) }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "strategy_tuning",
            strict: true,
            schema
          }
        }
      }
      : {
        model,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(context) }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "strategy_tuning",
            schema
          }
        }
      },
    transport,
    { maxOutputTokens: LLM_OUTPUT_TOKEN_CAPS.strategyTuning }
  );

  const traced = await withLlmGeneration(
    {
      name: "trading.strategy.tuning",
      model,
      userId,
      input: summarizeOpenAiRequest(body),
      metadata: {
        endpoint: url,
        transport
      },
      tags: ["strategy-tuning"],
      output: (result) => ({
        ...summarizeOpenAiResponseText(result.text),
        confidenceScore: result.payload.confidenceScore,
        cautionCount: result.payload.cautions.length,
        proposedPromptChars: result.payload.proposedPrompt.length,
        summaryChars: result.payload.summary.length
      })
    },
    async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${openaiKey}`
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Strategy tuning request failed with ${response.status}: ${detail.slice(0, 500)}`);
      }

      const payload = await response.json();
      recordLlmUsage({ userId, provider: "openai", model, context: "strategy-tuning", keySource, ...extractLlmUsage(payload) });
      const text = extractResponseText(payload);
      if (!text) throw new Error("Empty strategy tuning response returned from LLM API.");
      return { text, payload: JSON.parse(text) as LlmTuningPayload };
    }
  );

  return traced.payload;
}

function tuningSchema() {
  const nullableNumber = { type: ["number", "null"] };
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "summary",
      "rationale",
      "marketContext",
      "performanceReadout",
      "proposedPrompt",
      "scoringWeights",
      "policy",
      "riskRules",
      "cautions",
      "confidenceScore"
    ],
    properties: {
      summary: { type: "string" },
      rationale: { type: "string" },
      marketContext: { type: "string" },
      performanceReadout: { type: "string" },
      proposedPrompt: { type: "string" },
      scoringWeights: {
        type: "object",
        additionalProperties: false,
        required: ["liquidity", "momentum", "value", "quality", "volatility", "sentiment", "positioning", "diversification"],
        properties: {
          liquidity: nullableNumber,
          momentum: nullableNumber,
          value: nullableNumber,
          quality: nullableNumber,
          volatility: nullableNumber,
          sentiment: nullableNumber,
          positioning: nullableNumber,
          diversification: nullableNumber
        }
      },
      policy: {
        type: "object",
        additionalProperties: false,
        required: [
          "maxOrderNotional",
          "maxDailyNotional",
          "maxSymbolExposurePct",
          "maxDailyOrders",
          "maxProposalsPerRun",
          "runCadenceMinutes",
          "strategyAuthority",
          "runDuringExtendedHours"
        ],
        properties: {
          maxOrderNotional: nullableNumber,
          maxDailyNotional: nullableNumber,
          maxSymbolExposurePct: nullableNumber,
          maxDailyOrders: nullableNumber,
          maxProposalsPerRun: nullableNumber,
          runCadenceMinutes: nullableNumber,
          strategyAuthority: { enum: ["propose", "decide", null] },
          runDuringExtendedHours: { type: ["boolean", "null"] }
        }
      },
      riskRules: {
        type: "object",
        additionalProperties: false,
        required: ["stopLossPct", "takeProfitPct", "trailingStopPct"],
        properties: {
          stopLossPct: nullableNumber,
          takeProfitPct: nullableNumber,
          trailingStopPct: nullableNumber
        }
      },
      cautions: { type: "array", items: { type: "string" }, maxItems: 6 },
      confidenceScore: { type: "number" }
    }
  };
}

function extractResponseText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as {
    output_text?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
    output?: Array<{ content?: Array<{ text?: unknown }> }>;
  };
  if (typeof root.output_text === "string") return root.output_text;
  const chatText = root.choices?.[0]?.message?.content;
  if (typeof chatText === "string") return chatText;
  const responseText = root.output?.flatMap((item) => item.content ?? []).find((item) => typeof item.text === "string")?.text;
  return typeof responseText === "string" ? responseText : undefined;
}

function toPatch(payload: LlmTuningPayload, currentPrompt: string): StrategyTuningPatch {
  const scoringWeights = pruneNumeric(payload.scoringWeights);
  const policyPatch = prunePolicy(payload.policy);
  const riskRules = pruneNumeric(payload.riskRules);
  return {
    ...(payload.proposedPrompt.trim() && payload.proposedPrompt.trim() !== currentPrompt.trim()
      ? { prompt: payload.proposedPrompt.trim() }
      : {}),
    ...(Object.keys(scoringWeights).length ? { scoringWeights } : {}),
    ...(Object.keys(policyPatch).length || Object.keys(riskRules).length
      ? { policy: { ...policyPatch, ...(Object.keys(riskRules).length ? { riskRules } : {}) } }
      : {})
  };
}

function pruneNumeric<T extends Record<string, number | null | undefined>>(value: T): Partial<Record<keyof T, number>> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
  ) as Partial<Record<keyof T, number>>;
}

function prunePolicy(value: LlmTuningPayload["policy"]): NonNullable<StrategyTuningPatch["policy"]> {
  const patch: NonNullable<StrategyTuningPatch["policy"]> = {};
  for (const key of [
    "maxOrderNotional",
    "maxDailyNotional",
    "maxSymbolExposurePct",
    "maxDailyOrders",
    "maxProposalsPerRun",
    "runCadenceMinutes"
  ] as const) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) patch[key] = value[key];
  }

  if (value.strategyAuthority) patch.strategyAuthority = value.strategyAuthority;
  if (typeof value.runDuringExtendedHours === "boolean") patch.runDuringExtendedHours = value.runDuringExtendedHours;
  return patch;
}

function localRulesProposal(input: {
  policy: TradingPolicy;
  prompt: string;
  performance?: PerformanceSummary;
  fills: FillEvent[];
  latestDecision?: LatestDecisionPayload;
  closedLotCount: number;
  missedOpportunities?: MissedOpportunitySummary;
}): StrategyTuningProposal {
  const perf = compactPerformance(input.performance, input.policy.paperMode);
  const weakPerformance = typeof perf?.averageReturnPct === "number" && perf.averageReturnPct < 0;
  const lowSample = input.fills.length < 5;
  // Phase-7 §3.E guardrail: don't shift factor weights until enough lots have closed.
  const minLotsForWeights = input.policy.tuning?.minClosedLotsForWeightShift ?? MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT;
  const enoughLotsForWeights = input.closedLotCount >= minLotsForWeights;
  const proposedPrompt = input.prompt.includes("LEARNING LOOP")
    ? input.prompt
    : `${input.prompt.trim()}\n\nLEARNING LOOP\nBefore proposing trades, review recent fills, blocked proposals, and the latest market scan. If the recent sample is small, prefer smaller exploratory orders. If average return is negative, tighten risk and demand a clearer signal from price momentum, volume, valuation, and news sentiment before adding exposure.`;

  const riskMultiplier = weakPerformance ? 0.8 : 1;
  const maxOrderNotional = Math.max(1, Math.round((input.policy.maxOrderNotional ?? 100) * riskMultiplier));
  // Only adjust factor weights once the realized sample is large enough to trust;
  // below the gate we still improve the prompt and risk sizing, just not the weights.
  const scoringWeights: Partial<ScoringWeights> = !enoughLotsForWeights
    ? {}
    : weakPerformance
      ? {
          volatility: round(input.policy.scoringWeights.volatility + 0.2),
          quality: round(input.policy.scoringWeights.quality + 0.1),
          momentum: Math.max(0, round(input.policy.scoringWeights.momentum - 0.1))
        }
      : {
          diversification: round(input.policy.scoringWeights.diversification + 0.1),
          sentiment: round(input.policy.scoringWeights.sentiment + 0.1)
        };

  return {
    summary: lowSample
      ? "Collect more test/local evidence, but add an explicit learning loop to the prompt now."
      : weakPerformance
        ? "Recent average return is negative; tighten order size and require higher-quality signals."
        : "Recent performance is not flashing a drawdown warning; improve the prompt feedback loop and keep risk steady.",
    rationale:
      "This local rules review uses recent fills, run history, and latest scan metadata. Use the LLM review button again after configuring OPENAI_API_KEY for a model-generated rewrite.",
    marketContext:
      input.latestDecision?.marketScan
        ? `Latest scan covered ${input.latestDecision.marketScan.scannedSymbols} symbols from ${input.latestDecision.marketScan.source}.`
        : "No recent market scan is available yet; run the strategy once before relying on tuning suggestions.",
    performanceReadout: perf
      ? `Average return ${perf.averageReturnPct.toFixed(2)}%, win rate ${perf.winRate.toFixed(0)}%, realized P&L ${perf.realizedPnl.toFixed(2)}.`
      : "No performance summary is available because no account is selected.",
    proposedPatch: {
      prompt: proposedPrompt,
      scoringWeights,
      policy: {
        ...(weakPerformance ? { maxOrderNotional, maxProposalsPerRun: Math.max(1, input.policy.maxProposalsPerRun - 1) } : {}),
        riskRules: weakPerformance
          ? {
              stopLossPct: Math.max(1, round((input.policy.riskRules.stopLossPct ?? 8) * 0.85)),
              takeProfitPct: round(input.policy.riskRules.takeProfitPct ?? 20)
            }
          : {}
      }
    },
    cautions: [
      "Manual approval is required before changes are applied.",
      enoughLotsForWeights
        ? "Validate with another test/local run after applying changes."
        : `Only ${input.closedLotCount}/${minLotsForWeights} closed lots — withholding factor-weight changes until the realized sample is large enough to trust.`,
      ...(lowSample ? ["The trade sample is still small, so avoid overfitting."] : []),
      ...(input.missedOpportunities?.recurringFactor && input.missedOpportunities.recurringFactorCount
        ? [`Missed-opportunity signal: ${input.missedOpportunities.count} skipped name(s) rose; '${input.missedOpportunities.recurringFactor}' was the recurring dominant factor in ${input.missedOpportunities.recurringFactorCount} of them — consider whether scoringWeights under-weight it (subject to the closed-lot gate).`]
        : [])
    ],
    confidenceScore: lowSample ? 45 : weakPerformance ? 65 : 55,
    generatedBy: "local_rules"
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
