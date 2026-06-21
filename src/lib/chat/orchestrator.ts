// Per-turn chat flow:
//   1. Append the user message to the transcript (redact-on-write).
//   2. Ingest the message into salience memory (what to remember).
//   3. Assemble context (hard constraints first) into the system prompt.
//   4. Run the provider's tool loop — read-only / draft tools only, via an executeTool callback
//      that has NO execution capability (draft_order returns a ticket, never a fill).
//   5. Return { text, draft?, citations, usedMemories } — never executes a trade.
// Ported from reference/atlas-public-src/bff/orchestrator.mjs.

import { audit, getPolicy, listPendingProposals } from "../db";
import { getBrokerGateway } from "../broker";
import { retrieveContext } from "../vector-db";
import { createAlert as alertsCreateAlert, listAlerts as alertsListAlerts } from "../alerts";
import { addToWatchlist, listWatchlist as wlList } from "../watchlist";
import { canonicalTicker } from "../rag/chunk";
import { appendTurn, listTurns } from "../chat-history";
import { ingestMessage, retrieve } from "../memory/store";
import { classifyIntent, getLLM } from "./llm";
import { buildSystem, DISCLAIMER, PROMPT_VERSION } from "./prompt";
import { buildTools, type ToolDeps } from "./tools";
import type { ChatDraft, ChatLLM, ChatQuote, ChatReply, ToolSchema } from "./types";

export function makeOrchestrator(deps: ToolDeps, llm?: ChatLLM) {
  const model = llm ?? getLLM();
  const tools = buildTools();
  const toolSchemas: ToolSchema[] = Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    input_schema: t.input_schema
  }));

  return async function handleTurn(args: { userId: string; message: string }): Promise<ChatReply> {
    const { userId, message } = args;
    audit("chat.turn", { userId, message_len: message.length, prompt_version: PROMPT_VERSION }, userId);
    // Prior turns (redacted) for multi-turn context — fetched BEFORE appending the current message.
    const history = listTurns(userId, 10).map((t) => ({ role: t.role, text: t.text }));
    appendTurn(userId, { role: "user", text: message });

    const mem = ingestMessage(userId, message);
    const memories = retrieve(userId);
    const memorySummary = memories.map((m) => `- ${m.hard ? "[HARD] " : ""}${m.subject}: ${m.value}`).join("\n");

    // The only path to a tool — it has no execution capability.
    const executeTool = async (name: string, input: unknown) => {
      const tool = tools[name];
      if (!tool) return { error: "UNKNOWN_TOOL", name };
      audit("tool.call", { userId, tool: name }, userId);
      return tool.execute(input, { userId, deps });
    };

    const result = await model.run({
      system: buildSystem(memorySummary),
      message,
      tools: toolSchemas,
      executeTool,
      context: { memorySummary },
      history
    });

    // Server-side disclaimer guarantee (provider-independent): the system prompt asks for it, but we
    // never rely on the model to remember it — append if missing so compliance holds on every provider.
    const text = result.text.includes(DISCLAIMER) ? result.text : `${result.text}\n\n${DISCLAIMER}`;

    // Extract a draft (if any) for the UI; the assistant never executes.
    const draftCall = result.toolCalls?.find((c) => c.name === "draft_order" && c.result && !c.result.error);
    const draft = (draftCall?.result as ChatDraft) ?? null;

    const reply: ChatReply = {
      text,
      draft,
      citations: result.citations ?? [],
      usedMemories: memories.map((m) => ({ subject: m.subject, value: m.value, hard: m.hard })),
      memory: { written: mem.written.length, held: mem.held.length },
      intent: classifyIntent(message).intent,
      promptVersion: PROMPT_VERSION
    };
    appendTurn(userId, {
      role: "assistant",
      text: reply.text,
      citations: reply.citations.map((c) => c.chunk_id ?? c.source),
      intent: reply.intent
    });
    audit("chat.reply", { userId, has_draft: !!draft, citations: reply.citations.length }, userId);
    return reply;
  };
}

/** Production tool wiring to the canonical private subsystems (broker quotes, RAG, alerts, watchlist). */
export function buildProductionDeps(): ToolDeps {
  return {
    async getQuote(symbol, userId): Promise<ChatQuote> {
      const fallback: ChatQuote = { symbol, price_usd: 0, as_of: "", source: "none" };
      try {
        const policy = getPolicy(userId);
        const account = policy.accountNumber;
        if (!account) return { ...fallback, error: "NO_ACCOUNT" };
        const quotes = await getBrokerGateway(policy, userId).getEquityQuotes(account, [symbol]);
        const q = quotes[symbol];
        if (!q || typeof q.price !== "number") return { ...fallback, error: "NO_QUOTE" };
        return { symbol, price_usd: q.price, as_of: q.asOf ?? new Date().toISOString(), source: q.provider ?? "broker" };
      } catch {
        return { ...fallback, error: "QUOTE_FAILED" };
      }
    },
    async searchKnowledge(args, userId) {
      const symbol = args.ticker ? canonicalTicker(args.ticker) : "";
      if (!symbol) return [];
      const texts = await retrieveContext(args.query, symbol, args.k ?? 5, userId, args.as_of ? { asOf: args.as_of } : undefined);
      return texts.map((text, i) => ({ chunk_id: `${symbol}#${i + 1}`, text, source: "kb", as_of: args.as_of }));
    },
    createAlert(userId, input) {
      const result = alertsCreateAlert(userId, input);
      if ("error" in result) return result;
      return { symbol: result.symbol, op: result.op, price: result.price };
    },
    watchlistAdd(userId, symbol) {
      try {
        return { ok: true, item: addToWatchlist(userId, symbol) };
      } catch (e) {
        return { error: e instanceof Error ? e.message : "WATCHLIST_FAILED" };
      }
    },
    async getPositions(userId) {
      const policy = getPolicy(userId);
      if (!policy.accountNumber) return [];
      try {
        return await getBrokerGateway(policy, userId).getEquityPositions(policy.accountNumber);
      } catch {
        return [];
      }
    },
    async getPortfolio(userId) {
      const policy = getPolicy(userId);
      if (!policy.accountNumber) return null;
      try {
        return await getBrokerGateway(policy, userId).getPortfolio(policy.accountNumber);
      } catch {
        return null;
      }
    },
    listWatchlist(userId) {
      return wlList(userId);
    },
    listAlerts(userId) {
      return alertsListAlerts(userId, "armed");
    },
    listOpenProposals(userId) {
      const policy = getPolicy(userId);
      if (!policy.accountNumber) return [];
      return listPendingProposals(policy.accountNumber, userId);
    },
    accountLabel: "Test (local)"
  };
}
