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
import { jsonrepair } from "jsonrepair";

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
   * Sampling temperature for non-reasoning/deterministic-sampling paths (ignored by models that
   * reject custom temperature — reasoning models steer via `reasoningEffort` instead; see
   * `withLlmRequestBounds`). Defaults to `LLM_REQUEST_DEFAULTS.deterministicTemperature` (0) when
   * omitted, preserving every existing call site's greedy-decode behavior. Set explicitly for
   * per-role sampling (composite review B/medium/S): the Bear/debate adversary roles run at a
   * non-zero temperature so a single same-family, temperature-0 critique doesn't always find the
   * exact same (or no) objection — see the Bear/debateProposal call sites.
   */
  temperature?: number;
  /**
   * Structured-output schema. When present:
   * - OpenAI/compatible (non-DeepSeek, non-Gemini) → strict `json_schema` (unless `openAiJsonObject`);
   * - Gemini → strict `json_schema`, but with `type: [T,"null"]` / anyOf-with-null rewritten to
   *   Gemini's single-type + `nullable:true` dialect first (see `toGeminiJsonSchema`); falls back to
   *   `json_object` only if a construct can't be translated;
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
  userId?: string;
  metadata?: Record<string, string>;
}

/** Auth + content headers for the endpoint's provider (Anthropic uses x-api-key, others Bearer). */
export function llmAuthHeaders(endpoint: Pick<LlmEndpoint, "provider" | "key">): Record<string, string> {
  if (endpoint.provider === "anthropic") {
    return {
      "content-type": "application/json",
      "x-api-key": endpoint.key ?? "",
      "anthropic-version": "2023-06-01",
      // Honour cache_control blocks on the system prompt (prompt caching). (Chat A item 3.)
      "anthropic-beta": "prompt-caching-2024-07-31"
    };
  }
  if (endpoint.provider === "openrouter") {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${endpoint.key ?? ""}`,
      "HTTP-Referer": "https://socratictrade.com",
      "X-Title": "Socratic.Trade"
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
  const { systemPrompt, userContent, schema, openAiJsonObject, userId, metadata } = spec;
  const bounds = {
    maxOutputTokens: spec.maxOutputTokens,
    model: spec.model,
    reasoningEffort: spec.reasoningEffort,
    temperature: spec.temperature
  };

  // Build the OpenRouter-specific metadata tag if applicable.
  const inferredContext = () => {
    const sys = (systemPrompt || "").toLowerCase();
    const schemaName = schema?.name || "";
    if (schemaName === "trade_proposals" || sys.includes("green team") || sys.includes("proposer")) {
      return "green-team";
    }
    if (schemaName === "red_team_verdict" || sys.includes("red team") || sys.includes("reviewer") || sys.includes("adversary")) {
      return "red-team";
    }
    if (schemaName === "tuned_parameters" || sys.includes("tuner") || sys.includes("tuning") || sys.includes("autotuning")) {
      return "tuning";
    }
    if (sys.includes("salience") || sys.includes("memory") || sys.includes("importance")) {
      return "memory-salience";
    }
    if (sys.includes("multi-query") || sys.includes("rag") || sys.includes("retrieval")) {
      return "rag";
    }
    if (sys.includes("framework review") || sys.includes("framework_review")) {
      return "framework-review";
    }
    if (sys.includes("post-mortem") || sys.includes("post_mortem")) {
      return "post-mortem";
    }
    if (sys.includes("revalidation") || sys.includes("proposal-revalidation")) {
      return "revalidation";
    }
    return "assistant-chat";
  };

  const openRouterMetadata = endpoint.provider === "openrouter" ? {
    context: metadata?.context || inferredContext(),
    ...metadata
  } : undefined;

  const injectCommonFields = (base: Record<string, unknown>) => {
    if (userId) {
      if (endpoint.provider === "openrouter" || endpoint.provider === "openai" || endpoint.provider === "deepseek" || endpoint.provider === "gemini") {
        base.user = userId;
      } else if (endpoint.provider === "anthropic") {
        base.metadata = { ...(base.metadata as Record<string, unknown> || {}), user_id: userId };
      }
    }
    if (openRouterMetadata) {
      base.metadata = {
        ...(base.metadata as Record<string, unknown> || {}),
        ...openRouterMetadata
      };
    }
  };

  if (transport === "anthropic-messages") {
    const base: Record<string, unknown> = {
      model: spec.model,
      // Prompt-caching: send the (stable) system prompt as a single ephemeral cache block so
      // Anthropic reuses the cached KV across repeated strategy/red-team calls. The per-run dynamic
      // data lives in the user message, not here, so the whole system prefix is cacheable. The
      // caching beta header is added in llmAuthHeaders. (Chat A item 3; finer-grained prefix/suffix
      // splitting can follow if a dynamic tail is ever moved into the system prompt.)
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
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
    injectCommonFields(base);
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
    injectCommonFields(base);
    return withLlmRequestBounds(base, transport, bounds);
  }

  // responses transport (OpenAI)
  const base: Record<string, unknown> = { model: spec.model, input: messages };
  const textFormat = openAiResponsesTextFormat(schema, openAiJsonObject);
  if (textFormat) base.text = { format: textFormat };
  injectCommonFields(base);
  return withLlmRequestBounds(base, transport, bounds);
}

/**
 * Recursively rewrites a JSON Schema node so Gemini's OpenAI-compatible endpoint (an
 * OpenAPI-3.0-derived structured-output dialect) reliably accepts it. Three rewrites:
 *   1. `type: [T, "null"]` union-type arrays (the app's standard "optional numeric/string field"
 *      encoding — see the Bull trade-proposal schema's quantity/dollarAmount/limitPrice/stopPrice/
 *      bracketStopLoss/bracketTakeProfit in strategy.ts) → a single `type` plus `nullable: true`
 *      (Gemini's OpenAPI-3.0 dialect).
 *   2. An `anyOf` branch that is just `{ type: "null" }` (the app's "optional whole sub-object"
 *      encoding — see `autonomyOverrideSchema` in strategy.ts) — same fix, collapsed to the
 *      non-null branch with `nullable: true` added.
 *   3. `maxItems`/`minItems` on array nodes are STRIPPED from the wire schema and folded into the
 *      node's `description` instead. Root cause of the 2026-07-08 Roth Bull outage (400
 *      INVALID_ARGUMENT in ~1s, no field details): Gemini's structured-output validator expands an
 *      array's item subtree ONCE PER `maxItems` slot against an undocumented internal complexity
 *      budget, so `maxItems × <rich item schema>` overflows it — empirically, the 15-property Bull
 *      item schema passed at maxItems<=7 and was rejected at maxItems=8, while the SAME schema with
 *      two fewer properties passed at 8, and the Bear proposal schema (no maxItems, but the SAME
 *      nullable fields and anyOf) always passed. The count bound is advisory-for-the-model anyway:
 *      every consumer truncates deterministically app-side (`sanitizeProposals(..., maxProposals)`),
 *      so stripping it can never let extra proposals through — the description keeps the model
 *      aiming for the right count. (Constructs 1/2 are dialect-compat conversions kept from the
 *      earlier fix attempt; the raw unions were later shown to be accepted too, but the converted
 *      form is Gemini's documented dialect, so we keep emitting it.)
 *
 * Returns `unsupported: true` when the walk hits a shape this transform can't collapse into Gemini's
 * dialect (a `type` array or `anyOf` with more than one remaining non-null alternative — nothing in
 * this app's schemas does that today, but a future schema addition might), so the caller can fall back
 * to a bare `json_object` the same way the existing DeepSeek special case does, rather than forwarding
 * a schema Gemini is still likely to reject.
 */
export function toGeminiJsonSchema(node: unknown): { schema: unknown; unsupported: boolean } {
  let unsupported = false;

  const isNullOnly = (candidate: unknown): boolean =>
    !!candidate &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    (candidate as Record<string, unknown>).type === "null" &&
    Object.keys(candidate as Record<string, unknown>).length === 1;

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;

    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    // Item-count bounds stripped off this node (rewrite 3 above) — folded into `description` below.
    let minItems: number | undefined;
    let maxItems: number | undefined;

    for (const [key, val] of Object.entries(obj)) {
      if (key === "maxItems" || key === "minItems") {
        // Gemini's validator multiplies the item subtree by the bound (complexity blow-up, see the
        // doc comment) — never forward it; keep the intent as prose for the model instead. A
        // non-numeric bound (malformed schema) is stripped without a prose fold.
        if (typeof val === "number" && Number.isFinite(val)) {
          if (key === "maxItems") maxItems = val;
          else minItems = val;
        }
        continue;
      }
      if (key === "type" && Array.isArray(val)) {
        const nonNullTypes = val.filter((t) => t !== "null");
        const hadNull = nonNullTypes.length !== val.length;
        if (nonNullTypes.length === 1) {
          result.type = nonNullTypes[0];
          if (hadNull) result.nullable = true;
        } else {
          // Either no non-null type at all (malformed) or more than one — no single Gemini `type`
          // this can collapse to.
          unsupported = true;
          result.type = val;
        }
        continue;
      }
      if (key === "anyOf" && Array.isArray(val)) {
        const branches = val as unknown[];
        const nonNullBranches = branches.filter((b) => !isNullOnly(b));
        const hadNull = nonNullBranches.length !== branches.length;
        if (nonNullBranches.length === 1) {
          const collapsed = walk(nonNullBranches[0]) as Record<string, unknown>;
          Object.assign(result, collapsed);
          if (hadNull) result.nullable = true;
        } else {
          // Zero or 2+ non-null branches remain — can't collapse to a single Gemini-shaped node.
          unsupported = true;
          result.anyOf = nonNullBranches.map(walk);
          if (hadNull) result.nullable = true;
        }
        continue;
      }
      result[key] = walk(val);
    }
    if (maxItems !== undefined || minItems !== undefined) {
      const bound =
        maxItems !== undefined && minItems !== undefined
          ? `between ${minItems} and ${maxItems}`
          : maxItems !== undefined
            ? `at most ${maxItems}`
            : `at least ${minItems}`;
      const constraint = `Return ${bound} items.`;
      const existing = typeof result.description === "string" && result.description.trim().length > 0 ? `${result.description.trim()} ` : "";
      result.description = `${existing}${constraint}`;
    }
    return result;
  };

  return { schema: walk(node), unsupported };
}

function openAiChatResponseFormat(
  provider: LlmEndpoint["provider"],
  schema: LlmJsonSchema | undefined,
  openAiJsonObject: boolean | undefined
): Record<string, unknown> | undefined {
  if (schema && !openAiJsonObject && provider === "gemini") {
    const { schema: geminiSchema, unsupported } = toGeminiJsonSchema(schema.schema);
    if (unsupported) {
      // Something in this schema (a type-union or anyOf with more than one non-null alternative) has
      // no Gemini-dialect equivalent this transform can produce — fall back to a bare JSON object the
      // same way the DeepSeek branch below does, rather than forwarding a schema Gemini will likely
      // reject anyway. Logged so an unexpected new schema shape doesn't silently degrade output quality.
      console.warn(
        `[llm-call] Gemini schema "${schema.name}" has a construct toGeminiJsonSchema can't translate ` +
          "(type-union or anyOf with 2+ non-null branches) — falling back to json_object."
      );
      return { type: "json_object" };
    }
    return { type: "json_schema", json_schema: { name: schema.name, strict: true, schema: geminiSchema } };
  }
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
  // strict:true matches the chat-completions branch — without it the Responses API treats the
  // schema as advisory and schema-drifting output can slip through as merely JSON-shaped data.
  // Every schema routed here (Bull/Bear proposals, red-team verdict, revalidation, tuning) is
  // strict-conformant: additionalProperties:false + full required lists, null via type unions.
  if (schema && !openAiJsonObject) return { type: "json_schema", name: schema.name, strict: true, schema: schema.schema };
  if (schema || openAiJsonObject) return { type: "json_object" };
  return undefined;
}

/**
 * True when the model stopped because it hit the output-token cap (a truncated answer), across
 * transports: OpenAI chat-completions `finish_reason:"length"`, OpenAI responses API
 * `incomplete_details.reason:"max_output_tokens"` / top-level `status:"incomplete"`, and Anthropic
 * Messages `stop_reason:"max_tokens"`. A truncated JSON answer usually fails to parse, so callers use
 * this to distinguish "output cap too small" from a genuine empty result.
 */
export function detectLlmTruncation(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as {
    stop_reason?: unknown;
    choices?: unknown;
    status?: unknown;
    incomplete_details?: { reason?: unknown } | null;
    output?: unknown;
  };
  if (p.stop_reason === "max_tokens") return true;
  if (Array.isArray(p.choices) && p.choices.some((c) => (c as { finish_reason?: unknown } | null)?.finish_reason === "length")) return true;
  if (p.status === "incomplete" && p.incomplete_details?.reason === "max_output_tokens") return true;
  if (Array.isArray(p.output) && p.output.some((o) => (o as { status?: unknown } | null)?.status === "incomplete")) return true;
  return false;
}

/**
 * Extract the model's text answer across all transports, normalized to a string the caller can
 * `JSON.parse` (when a schema was used) or read directly (free text):
 * - OpenAI responses API: `output_text`, else the first text block in `output[]`.
 * - OpenAI/compatible chat-completions: `choices[0].message.content`.
 * - Mistral chat-completions at high reasoning effort: `choices[0].message.content` is a LIST of
 *   chunks (`{type:"thinking", thinking:[...]}` + `{type:"text", text}`) rather than a plain
 *   string — only the `"text"` chunk(s) are the answer.
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

  // Mistral high-reasoning-effort chat-completions responses: `message.content` is a list of
  // chunks instead of a string (https://docs.mistral.ai/studio-api/conversations/reasoning).
  // Concatenate only the final-answer "text" chunk(s); skip "thinking" chunks (the reasoning
  // trace), mirroring how the Anthropic content-block case below skips non-text blocks.
  if (Array.isArray(chatText)) {
    const chunks = chatText as Array<{ type?: unknown; text?: unknown }>;
    const textJoined = chunks
      .filter((chunk) => chunk?.type === "text" && typeof chunk.text === "string")
      .map((chunk) => chunk.text as string)
      .join("");
    if (textJoined.length > 0) return textJoined;
  }

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

/**
 * Extract a JSON object/array payload from an LLM text response that may be wrapped in
 * markdown code fences or surrounded by prose. Root-cause fix for the `gemini-3.5-flash`
 * failure where a fenced / prose-wrapped reply made a bare `JSON.parse(text)` throw and
 * silently disabled the adversarial review (see docs/single-adversary-consolidation.md
 * §4.1 + review point R9).
 *
 * Strategy: (1) strip an enclosing ```json / ``` fence; (2) if the remainder still isn't
 * bare JSON, return the FIRST BALANCED `{…}` or `[…]` block, scanned string- and
 * escape-aware so braces inside string values don't miscount. This is deliberately NOT a
 * greedy first-`{`-to-last-`}` slice (R9): that corrupts output when prose contains a
 * stray bracket or multiple JSON-looking blocks. When no balanced block is found (e.g. a
 * truncated response), returns the trimmed/unfenced text unchanged so the caller's own
 * `JSON.parse` try/catch still governs the failure — never fabricates valid JSON.
 *
 * `repair` (default OFF) additionally runs local, deterministic jsonrepair when the
 * extracted payload still isn't valid JSON. Opt-in ONLY, per call site, because repair can
 * turn a TRUNCATED response into syntactically valid JSON — e.g. `{"verdict":"approve"`
 * becomes a well-formed approval object. On safety-critical parse paths (Red Team verdicts,
 * proposal revalidation, tuning payloads) that converts fail-closed "unavailable" handling
 * into fail-open acceptance, which is exactly the defect class Codex flagged on PR #1696.
 * Those sites MUST call this without `repair`; generative sites that opt in MUST re-validate
 * schema-required fields on the parsed result (repair proves syntax, never completeness).
 */
export function extractJsonPayload(text: string, options: { repair?: boolean } = {}): string {
  const unfenced = text
    .trim()
    .replace(/^```(?:json5?|jsonc)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const primary = firstBalancedJson(unfenced) ?? unfenced;

  try {
    JSON.parse(primary);
    return primary;
  } catch {
    if (!options.repair) return primary; // caller's own JSON.parse governs the failure
    // Repair the ORIGINAL unfenced text before the balanced slice: firstBalancedJson only
    // understands double-quoted strings, so a single-quoted payload whose string values
    // contain '}' gets sliced MID-STRING — repairing that fragment silently truncates content
    // or drops trailing proposals (Codex P2, round 9). Full-text repair sees the whole payload;
    // the slice remains only as a fallback for prose-wrapped responses where full-text repair
    // cannot apply. Wrong-content beats no-content on this path: a full-text repair that
    // yields a non-object degrades to zero proposals downstream, which is the safe direction.
    try {
      const repairedFull = jsonrepair(unfenced);
      JSON.parse(repairedFull);
      return repairedFull;
    } catch {
      // fall through to the balanced slice
    }
    try {
      return jsonrepair(primary);
    } catch {
      // Unrepairable; let the caller's JSON.parse fail loudly
      return primary;
    }
  }
}

/** First balanced `{…}`/`[…]` block starting at the first opener, or undefined if none/unbalanced. */
function firstBalancedJson(text: string): string | undefined {
  const start = text.search(/[[{]/);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined; // unbalanced (e.g. truncated) — let the caller's JSON.parse fail loudly
}
