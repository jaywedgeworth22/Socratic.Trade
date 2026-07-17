import { jsonrepair } from "jsonrepair";
import { extractJsonPayload } from "./llm-call";

/**
 * Deterministically attempts to heal malformed JSON payloads.
 * This function uses purely local, syntax-based repair (via the `jsonrepair` package)
 * to fix common truncation or syntax issues without making any network/LLM fallback calls.
 * 
 * @param text The malformed JSON string (or the raw text containing a JSON payload)
 * @returns The parsed object if healing succeeds, or undefined if it fails.
 */
export function healMalformedJson<T>(text: string): T | undefined {
  try {
    let targetText = extractJsonPayload(text);
    
    // If extractJsonPayload returned the full text because it was unbalanced (truncated),
    // it might still have prose before the JSON. Find the first '{' or '['.
    const start = targetText.search(/[[{]/);
    if (start !== -1) {
      targetText = targetText.substring(start);
    }

    const repaired = jsonrepair(targetText);
    const parsed = JSON.parse(repaired);
    
    // jsonrepair might wrap multiple items in an array if it thinks it's a list of JSON items.
    // If we get an array but expected an object, or we got a string, we need to filter.
    if (Array.isArray(parsed) && parsed.length > 0) {
      // Find the first object in the array if it wrapped it.
      const firstObject = parsed.find(item => typeof item === "object" && item !== null);
      if (firstObject) return firstObject as T;
    }

    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }

    return parsed as T;
  } catch (err) {
    // If jsonrepair also fails, the payload is too broken to heal.
    return undefined;
  }
}
