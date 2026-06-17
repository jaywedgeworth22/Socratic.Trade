import { getDb, setSetting, audit, getInternalSetting, setInternalSetting, getPolicy } from "./db";
import { getThesisScorecard } from "./performance";

export async function generateReflectionSummary(accountNumber: string): Promise<void> {
  const db = getDb();
  
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
    WHERE f.account_number = ? AND f.status = 'filled'
    ORDER BY f.filled_at DESC
    LIMIT 50
  `).all(accountNumber) as any[];

  if (rows.length === 0) return;

  // Gate: only regenerate when the trade history actually changed since the last
  // reflection. The signature is (#trades, latest fill time). This skips a whole
  // LLM call on the common run where nothing filled, and keeps the Bull agent's
  // system prompt stable run-to-run so the provider's prompt cache can hit.
  const signature = `${rows.length}:${rows[0]?.filled_at ?? ""}`;
  if (getInternalSetting<string>("reflection_signature") === signature) return;

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

  // Realized outcomes grouped by thesis tag so the reflection is grounded in what
  // actually made or lost money, not just what was traded.
  const source = getPolicy().paperMode ? "paper" : "live";
  const outcomesByThesis = getThesisScorecard(accountNumber, source);

  const systemPrompt = `You are the Post-Mortem Reflection Engine.
Review the recent trades together with 'outcomesByThesis' (realized win rate, average return, and total P&L grouped by 'tradeThesisTag') and extract actionable, outcome-grounded lessons.
Call out which thesis tags and market regimes have actually been profitable versus losing, and what the agent should do more of or stop doing.
Return a single concise paragraph (<= 120 words). This paragraph is fed back into the Bull Agent's prompt on future runs to improve trading accuracy, so make it specific and directive.`;

  const userContent = JSON.stringify({ recentTrades: tradeData, outcomesByThesis });

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
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      console.warn("Post-mortem LLM call failed", await response.text());
      return;
    }

    const payload = await response.json();
    const text = payload.choices?.[0]?.message?.content ??
                 payload.output_text ??
                 payload.output?.flatMap((item: any) => item.content ?? []).find((item: any) => item.text)?.text;

    if (text) {
      setSetting("reflection_summary", text);
      setInternalSetting("reflection_signature", signature);
      audit("post_mortem_reflection", { summary: text, tradeCount: tradeData.length, outcomesByThesis });
    }
  } catch (error) {
    console.error("Failed to generate reflection summary:", error);
  }
}

function truncate(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
