import { getDb, setUserSetting, audit, getInternalSetting, setInternalSetting, getPolicy, resolveApiKey } from "./db";
import { getRegimeScorecard, getThesisScorecard } from "./performance";
import { getExcursionsByThesis } from "./learning-loop";
import { withLlmGeneration } from "./observability";
import { summarizeOpenAiRequest, summarizeOpenAiResponseText } from "./telemetry-sanitize";

export async function generateReflectionSummary(accountNumber: string, userId: string = "local"): Promise<void> {
  const db = getDb();
  const openaiKey = resolveApiKey("openai", userId);
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
  const signature = `${rows.length}:${rows[0]?.filled_at ?? ""}`;
  const signatureKey = `reflection_signature:${userId}`;
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
  const source = getPolicy(userId).paperMode ? "paper" : "live";
  const outcomesByThesis = getThesisScorecard(accountNumber, source, {}, userId);
  const outcomesByRegime = getRegimeScorecard(accountNumber, source, {}, userId);
  const timingByThesis = await getExcursionsByThesis(accountNumber, source, { userId }).catch(() => []);

  const systemPrompt = `You are the Post-Mortem Reflection Engine.
Review the recent trades together with:
- 'outcomesByThesis' / 'outcomesByRegime': realized win rate, average return, and total P&L grouped by 'thesisTag' and by 'regime' respectively (these mirror the proposal's tradeThesisTag and entryMarketRegime).
- 'timingByThesis': average maximum adverse excursion (avgMaePct, pain endured), average maximum favorable excursion (avgMfePct, the move that was available), and capturePct (share of the favorable move actually realized; low => exiting winners too early, large negative avgMaePct => holding losers through deep drawdowns).
Extract actionable, outcome-grounded lessons: which thesis tags and regimes are profitable vs losing, and whether exits are mistimed.
Return a single concise paragraph (<= 130 words) that is specific and directive. It is fed back into the Bull Agent's prompt on future runs to improve trading accuracy.`;

  const userContent = JSON.stringify({ recentTrades: tradeData, outcomesByThesis, outcomesByRegime, timingByThesis });

  const url = process.env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions";
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const isChatCompletions = url.includes("/chat/completions");

  const body = isChatCompletions
    ? {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent }
        ]
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
        name: "trading.post-mortem.reflection",
        model,
        userId,
        input: summarizeOpenAiRequest(body),
        metadata: {
          endpoint: url,
          transport: isChatCompletions ? "chat-completions" : "responses",
          tradeCount: tradeData.length,
          source
        },
        tags: ["post-mortem", "reflection"],
        output: (result) => summarizeOpenAiResponseText(result.text)
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
          console.warn("Post-mortem LLM call failed", await response.text());
          return { text: undefined };
        }

        const payload = await response.json();
        const text = payload.choices?.[0]?.message?.content ??
                     payload.output_text ??
                     payload.output?.flatMap((item: { content?: Array<{ text?: string }> }) => item.content ?? []).find((item: { text?: string }) => item.text)?.text;

        return { text: typeof text === "string" ? text : undefined };
      }
    );

    if (traced.text) {
      setUserSetting(userId, "reflection_summary", traced.text);
      setInternalSetting(signatureKey, signature);
      audit("post_mortem_reflection", {
        summary: traced.text,
        tradeCount: tradeData.length,
        outcomesByThesis,
        outcomesByRegime,
        timingByThesis
      }, userId);
    }
  } catch (error) {
    console.error("Failed to generate reflection summary:", error);
  }
}

function truncate(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
