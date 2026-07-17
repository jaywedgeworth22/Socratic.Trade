import { extractJsonPayload } from "./llm-call";
import { resolveOpenAiModel, withLlmRequestBounds, LlmTransport } from "./llm-request";
import { withLlmGeneration } from "./observability";

export interface HealJsonOptions {
  model?: string;
  userId?: string;
  connectedAccountId?: string;
}

/**
 * Attempts to heal a malformed or truncated LLM JSON response using a fast/cheap fallback model.
 * 
 * @param brokenJson The raw malformed text returned by the primary model.
 * @param options Contextual options for routing and observability.
 * @returns The repaired JSON string, or undefined if healing failed.
 */
export async function healMalformedJson(
  brokenJson: string,
  options: HealJsonOptions
): Promise<string | undefined> {
  const model = options.model ?? "gemini-2.5-flash";
  const resolvedModel = resolveOpenAiModel({ llmModel: model });
  const transport: LlmTransport = "chat-completions";
  const url = "https://openrouter.ai/api/v1/chat/completions";
  
  const systemPrompt = `You are a strict JSON repair tool. 
The following text contains malformed or truncated JSON from another AI model.
Your task is to fix the syntax errors, close any unclosed brackets or strings, and output ONLY the corrected, valid JSON.
Do not add any conversational text, explanations, or markdown formatting outside of the JSON block.
Do not modify the semantic values unless necessary to fix the syntax.
If the JSON appears truncated, logically close the remaining open objects and arrays.`;

  const body = {
    model: resolvedModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Malformed JSON:\n\n${brokenJson}` }
    ]
  };

  const finalBody = withLlmRequestBounds(body, transport, { 
    model: resolvedModel, 
    maxOutputTokens: 8000 // Provide enough headroom for a full repair
  });

  try {
    const result = await withLlmGeneration(
      {
        name: "trading.strategy.heal_json",
        model: resolvedModel,
        userId: options.userId,
        connectedAccountId: options.connectedAccountId,
        input: { original_length: brokenJson.length },
        metadata: {
          endpoint: url,
          transport
        },
        tags: ["response-healing"],
        output: (result) => ({ healed_length: result.length })
      },
      async () => {
        const fetchLlmWithRetry = (await import("./llm-request")).fetchLlmWithRetry;
        const resp = await fetchLlmWithRetry(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(finalBody)
        }, { attempts: 2, timeoutMs: 30000 });
        
        if (!resp.ok) {
          throw new Error(`Healing model returned HTTP ${resp.status}`);
        }
        
        const json = await resp.json() as { choices?: { message?: { content?: string } }[] };
        const content = json.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error("Healing model returned empty content");
        }
        
        return content;
      }
    );
    
    // Validate that the healed output actually parses
    const extracted = extractJsonPayload(result);
    JSON.parse(extracted);
    return extracted;
  } catch (error) {
    console.warn(`Response healing failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
