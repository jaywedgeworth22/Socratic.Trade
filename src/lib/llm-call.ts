// Shared LLM request shaping for the strategy/analysis call sites (Bull proposer, Bear/Red-Team
// reviewer, strategy tuning, proposal re-validation, post-mortem reflection). It turns a single
// provider-agnostic request spec into the correct wire body + auth headers for whichever transport
// `resolveLlmEndpoint` picked, and extracts the model's text/JSON back out uniformly.
//
// Why this exists: those call sites historically hand-built an OpenAI-shaped body (Bearer auth,
// `response_format` / `text.format`, `choices[].message.content`). Anthropic's Messages API is a
// different shape (top-level `system`, `max_tokens`, `x-api-key`, forced tool-use for guaranteed
// JSON, content-block responses). Centralizing the per-transport shaping here lets Claude be a
// first-class Green/Red team model everywhere those sites run, instead of OpenAI-only.

import { withLlmRequestBounds, type LlmTransport } from "./llm-request";
import type { LlmEndpoint } from "./llm-provider";
import type { LlmReasoningEffort } from "./types";

/** A JSON schema plus the name/description used to label it (OpenAI json_schema / Anthropic tool). */
export interface LlmJsonSchema {
  name: string;
  schema: Record<string, unknown>;
  description?: string;
}

export interface LlmRequestSpec {
  /** The resolved model id (from the endpoint) that this body targets. */
  model: string;
  systemPrompt: string;
  /** The user turn — already serialized (JSON string or plain text). */
  userContent: string;
  maxOutputTokens: number;
  reasoningEffort?: LlmReasoningEffort;
  /**
   * Structured-output schema. When present:
   * - OpenAI/compatible (non-DeepSeek) → strict `json_schema` (unless `openAiJsonObject`);
   * - DeepSeek → `json_object` (it rejects strict json_schema);
   * - Anthropic → a single forced tool whose `input_schema` is this schema (reliable JSON).
   * Omit for free-text output (e.g. the post-mortem reflection paragraph).
   */
  schema?: LlmJsonSchema;
  /**
   * Force OpenAI-compatible providers to use `json_object` instead of strict `json_schema`, even
   * when a `schema` is supplied. Anthropic still uses the schema as a forced tool. Used by the
   * Red-Team debate, which historically asked OpenAI for a bare JSON object (prompt-described shape)
   * rather than a strict schema — this preserves that behavior while letting Claude enforce a tool.
   */
  openAiJsonObject?: boolean;
}

/** Auth + content headers for the endpoint's provider (Anthropic uses x-api-key, others Bearer). */
export function llmAuthHeaders(endpoint: Pick<LlmEndpoint, "provider" | "key">): Record<string, string> {
  if (endpoint.provider === "anthropic") {
    return {
      "content-type": "application/json",
      "x-api-key": endpoint.key ?? "",
      "anthropic-version": "2023-06-01"
    };
  }
  return {
    "content-type": "application/json",
    authorization: `Bearer ${endpoint.key ?? ""}`
  };
}

/** Build the provider-correct request body (already bounded with token caps / sampling params). */
export function buildLlmRequestBody(
  endpoint: Pick<LlmEndpoint, "provider" | "transport">,
  spec: LlmRequestSpec
): Record<string, unknown> {
  const { transport } = endpoint;
  const { systemPrompt, userContent, schema, openAiJsonObject } = spec;
  const bounds = { maxOutputTokens: spec.maxOutputTokens, model: spec.model, reasoningEffort: spec.reasoningEffort };

  if (transport === "anthropic-messages") {
    const base: Record<string, unknown> = {
      model: spec.model,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }]
    };
    if (schema) {
      // Forced tool-use is Anthropic's structured-output mechanism: the model must call this single
      // tool, so its `input` comes back as schema-shaped JSON (no prose to strip / regex out).
      base.tools = [
        {
          name: schema.name,
          description: schema.description ?? `Return the result as ${schema.name}.`,
          input_schema: schema.schema
        }
      ];
      base.tool_choice = { type: "tool", name: schema.name };
    }
    return withLlmRequestBounds(base, transport, bounds);
  }

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent }
  ];

  if (transport === "chat-completions") {
    const base: Record<string, unknown> = { model: spec.model, messages };
    const responseFormat = openAiChatResponseFormat(endpoint.provider, schema, openAiJsonObject);
    if (responseFormat) base.response_format = responseFormat;
    return withLlmRequestBounds(base, transport, bounds);
  }

  // responses transport (OpenAI)
  const base: Record<string, unknown> = { model: spec.model, input: messages };
  const textFormat = openAiResponsesTextFormat(schema, openAiJsonObject);
  if (textFormat) base.text = { format: textFormat };
  return withLlmRequestBounds(base, transport, bounds);
}

function openAiChatResponseFormat(
  provider: LlmEndpoint["provider"],
  schema: LlmJsonSchema | undefined,
  openAiJsonObject: boolean | undefined
): Record<string, unknown> | undefined {
  if (schema && !openAiJsonObject && provider !== "deepseek") {
    return { type: "json_schema", json_schema: { name: schema.name, strict: true, schema: schema.schema } };
  }
  // DeepSeek rejects strict json_schema; everything else here wants a bare JSON object.
  if (schema || openAiJsonObject) return { type: "json_object" };
  return undefined;
}

function openAiResponsesTextFormat(
  schema: LlmJsonSchema | undefined,
  openAiJsonObject: boolean | undefined
): Record<string, unknown> | undefined {
  if (schema && !openAiJsonObject) return { type: "json_schema", name: schema.name, schema: schema.schema };
  if (schema || openAiJsonObject) return { type: "json_object" };
  return undefined;
}

/**
 * Extract the model's text answer across all transports, normalized to a string the caller can
 * `JSON.parse` (when a schema was used) or read directly (free text):
 * - OpenAI responses API: `output_text`, else the first text block in `output[]`.
 * - OpenAI/compatible chat-completions: `choices[0].message.content`.
 * - Anthropic Messages: a `tool_use` block's `input` (re-serialized to JSON) if present, else the
 *   concatenated `text` blocks.
 */
export function extractLlmText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as {
    output_text?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
    output?: Array<{ content?: Array<{ text?: unknown }> }>;
    content?: Array<{ type?: string; text?: unknown; input?: unknown }>;
  };

  if (typeof root.output_text === "string" && root.output_text.length > 0) return root.output_text;

  const chatText = root.choices?.[0]?.message?.content;
  if (typeof chatText === "string" && chatText.length > 0) return chatText;

  // Anthropic Messages content blocks.
  if (Array.isArray(root.content)) {
    const toolUse = root.content.find((b) => b?.type === "tool_use" && b.input !== undefined);
    if (toolUse) return JSON.stringify(toolUse.input);
    const textJoined = root.content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    if (textJoined.length > 0) return textJoined;
  }

  const responseText = root.output
    ?.flatMap((item) => item.content ?? [])
    .find((item) => typeof item.text === "string")?.text;
  if (typeof responseText === "string") return responseText;

  // Fall back to an empty OpenAI chat string (preserves prior `typeof content === "string"` semantics).
  return typeof chatText === "string" ? chatText : undefined;
}
