import { resolveLlmEndpoint } from "../llm-provider";
import { llmAuthHeaders } from "../llm-call";

/**
 * Decomposes a single complex user query into 2-3 specific, targeted sub-queries.
 * Falls back to a heuristic conjunction split on any failure.
 */
export async function deconstructQuery(query: string, userId: string = "local"): Promise<string[]> {
  const originalClean = query.trim();
  if (!originalClean) return [];

  // If query is short, don't decompose it
  const words = originalClean.split(/\s+/);
  if (words.length <= 4) return [originalClean];

  try {
    const policy = { llmModel: "gpt-4o-mini" }; // use default lightweight model
    const endpoint = resolveLlmEndpoint(policy, userId);
    if (!endpoint.key) {
      return fallbackDeconstruct(originalClean);
    }

    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...llmAuthHeaders({ provider: endpoint.provider, key: endpoint.key })
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [
          {
            role: "system",
            content: "You are a financial analyst. Decompose a complex search query into 2 to 3 simple, specific sub-queries (each targeted at specific parts of a financial filing, like balance sheets, income statements, or footnotes). Respond ONLY with a JSON object containing a 'queries' array of strings. Example: { \"queries\": [\"subquery 1\", \"subquery 2\"] }"
          },
          {
            role: "user",
            content: `Decompose this query: "${originalClean}"`
          }
        ],
        response_format: { type: "json_object" }
      })
    });

    if (response.ok) {
      const result = await response.json();
      const text = result.choices?.[0]?.message?.content || "";
      const parsed = JSON.parse(text);
      const queries = Array.isArray(parsed) ? parsed : (parsed.queries || parsed.subQueries || []);
      if (Array.isArray(queries) && queries.length > 0) {
        return queries.map((q: any) => String(q).trim()).filter(Boolean);
      }
    }
  } catch (err) {
    console.warn("[query-deconstruct] failed to deconstruct query via LLM; falling back to heuristic:", err);
  }

  return fallbackDeconstruct(originalClean);
}

function fallbackDeconstruct(query: string): string[] {
  const clauses = query.split(/\s+(?:and|or|with|vs|about|regarding)\s+/i);
  const cleanClauses = clauses.map((c) => c.trim()).filter((c) => c.length > 3);
  return cleanClauses.length > 1 ? cleanClauses : [query];
}
