import { getDb, setSetting, audit } from "./db";

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

  const tradeData = rows.map((r) => ({
    symbol: r.symbol,
    side: r.side,
    quantity: r.quantity,
    price: r.price,
    notional: r.notional,
    filledAt: r.filled_at,
    thesisTag: r.trade_thesis_tag,
    regime: r.entry_market_regime,
    rationale: r.proposal ? JSON.parse(r.proposal).rationale : undefined
  }));

  const systemPrompt = `You are the Post-Mortem Reflection Engine.
Your job is to review the recent trades and extract actionable insights, lessons learned, and performance characteristics grouped by 'tradeThesisTag'.
Identify which thesis tags and regimes are prevalent, and provide a holistic reflection on recent trading behavior.
Return a single concise paragraph summarizing your findings. This paragraph will be fed back into the Bull Agent's prompt for future runs to improve its trading accuracy.`;

  const userContent = JSON.stringify({ recentTrades: tradeData });

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
      audit("post_mortem_reflection", { summary: text, tradeCount: tradeData.length });
    }
  } catch (error) {
    console.error("Failed to generate reflection summary:", error);
  }
}
