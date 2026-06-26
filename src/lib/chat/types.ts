// Types for the chat orchestrator (ported from the Atlas BFF). Kept local to the chat module.

export interface ChatQuote {
  symbol: string;
  price_usd: number;
  /** Intraday % change vs prior close — omitted when the source doesn't provide it (never fabricated). */
  change_pct?: number;
  as_of: string;
  source: string;
  /** Trading session label — omitted when unknown (never fabricated). */
  session?: string;
  error?: string;
}

export interface KbChunk {
  chunk_id: string;
  text: string;
  source: string;
  as_of?: string;
  doc_id?: string;
  title?: string;
  section?: string;
  score?: number;
  url?: string;
}

/** A draft order ticket. `executed` is always false — the chat assistant has no execution path. */
export interface ChatDraft {
  draft_id: string;
  symbol: string;
  side: string;
  qty: number;
  order_type: string;
  limit_usd: number | null;
  rationale: string;
  account_label: string;
  is_real: boolean;
  blocked: boolean;
  warnings: string[];
  executed: false;
}

export interface Citation {
  source: string;
  chunk_id?: string;
  as_of?: string;
  url?: string;
}

export interface ToolCall {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlmRunArgs {
  system: string;
  message: string;
  tools: ToolSchema[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeTool: (name: string, input: any) => Promise<any>;
  context?: { memorySummary?: string };
  /** Prior redacted turns (chronological) for multi-turn context. The current message is separate. */
  history?: Array<{ role: "user" | "assistant"; text: string }>;
}

export interface LlmResult {
  text: string;
  toolCalls: ToolCall[];
  citations: Citation[];
}

export interface ChatLLM {
  run(args: LlmRunArgs): Promise<LlmResult>;
  /** The model id this LLM speaks to (e.g. "gpt-5.4-mini", "claude-opus-4-8", "mock"). Recorded on
   *  each assistant turn and shown in the transcript / hover so the user can see who answered. */
  readonly modelName?: string;
}

export interface ChatReply {
  text: string;
  draft: ChatDraft | null;
  citations: Citation[];
  usedMemories: Array<{ subject: string; value: string; hard: boolean }>;
  memory: { written: number; held: number };
  intent: string;
  promptVersion: string;
  /** Model that produced this reply (so the UI can tag the message without a refetch). */
  model?: string;
}
