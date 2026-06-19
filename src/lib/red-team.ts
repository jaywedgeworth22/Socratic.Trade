import { getPolicy, getStrategyPrompt, resolveApiKey } from "./db";
import { withLlmGeneration } from "./observability";
import { summarizeOpenAiRequest, summarizeOpenAiResponseText } from "./telemetry-sanitize";
import type { MarketQuoteSummary, TradeProposal } from "./types";

export interface RedTeamDebateResult {
  rejected: boolean;
  reason: string;
}

export async function debateProposal(
  proposal: TradeProposal,
  quote: MarketQuoteSummary | undefined,
  isBullish: boolean,
  userId: string = "local"
): Promise<RedTeamDebateResult> {
  const policy = getPolicy(userId);
  const basePrompt = getStrategyPrompt(userId);
  const openaiKey = resolveApiKey("openai", userId);
  if (!openaiKey) return { rejected: false, reason: "Red Team debate skipped because OpenAI is not configured." };
  
  const systemPrompt = `You are the Red Team Risk Agent. Your job is to rigorously critique the strategy's high-conviction trade proposals.
  
The strategy has proposed to ${proposal.side.toUpperCase()} ${proposal.symbol} with a confidence score of ${proposal.confidenceScore ?? 'N/A'}/100.
Rationale provided: ${proposal.rationale}

Your objective is to play the Devil's Advocate. You must actively search for reasons why this trade will FAIL.
If the proposal is a BUY or COVER (bullish), you are the BEAR. Look for poor fundamentals, bad smart-money signals, or overbought technicals.
If the proposal is a SELL or SHORT (bearish), you are the BULL. Look for strong fundamentals, insider buying, or oversold technicals.

If you find a critical flaw that invalidates the rationale, you MUST REJECT the proposal.
If the rationale is sound and you cannot find a critical flaw, you MUST APPROVE the proposal.

Respond with a JSON object containing:
- rejected: boolean (true if you found a critical flaw, false if approved)
- reason: string (your counter-argument or approval reasoning)`;

  const userContent = JSON.stringify({
    proposal,
    quote,
    isBullish,
    policy: {
      strategyAuthority: policy.strategyAuthority,
      holdingHorizon: policy.holdingHorizon,
      maxOrderNotional: policy.maxOrderNotional,
      maxDailyNotional: policy.maxDailyNotional,
      scoringWeights: policy.scoringWeights
    },
    strategyPrompt: basePrompt
  });

  const url = process.env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions";
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const isChatCompletions = url.includes("/chat/completions");

  const body = isChatCompletions
    ? {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent }
        ],
        response_format: { type: "json_object" }
      }
    : {
        model,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent }
        ]
      };

  try {
    const traced = await withLlmGeneration(
      {
        name: "trading.red-team.debate",
        model,
        userId,
        input: summarizeOpenAiRequest(body),
        metadata: {
          endpoint: url,
          transport: isChatCompletions ? "chat-completions" : "responses",
          symbol: proposal.symbol,
          side: proposal.side,
          isBullish
        },
        tags: ["red-team", "proposal-review"],
        output: (result) => ({
          ...summarizeOpenAiResponseText(result.text),
          rejected: result.debate.rejected,
          reasonChars: result.debate.reason.length
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
          console.warn("Red Team LLM call failed", await response.text());
          return {
            text: undefined,
            debate: { rejected: false, reason: "Red Team debate failed to execute." }
          };
        }

        const payload = await response.json();
        const text = payload.choices?.[0]?.message?.content ??
                     payload.output_text ??
                     payload.output?.flatMap((item: { content?: Array<{ text?: string }> }) => item.content ?? []).find((item: { text?: string }) => item.text)?.text;

        if (text) {
          const parsed = JSON.parse(text) as RedTeamDebateResult;
          return {
            text,
            debate: {
              rejected: !!parsed.rejected,
              reason: parsed.reason || "No reason provided."
            }
          };
        }

        return {
          text: undefined,
          debate: { rejected: false, reason: "Red Team evaluation returned no response." }
        };
      }
    );
    return traced.debate;
  } catch (error) {
    console.error("Failed to debate proposal:", error);
  }

  return { rejected: false, reason: "Red Team evaluation errored out." };
}
