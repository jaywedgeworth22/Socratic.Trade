// Tool registry. The model may request ONLY these. There is no execution tool — draft_order
// returns a ticket for human confirmation; it never places an order. All tool I/O is injected via
// ToolDeps so the loop is testable offline. Ported from reference/atlas-public-src/bff/tools.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "crypto";
import { canonicalTicker } from "../rag/chunk";
import type { ChatDraft, ChatQuote, KbChunk } from "./types";

export type AlertResult = { symbol: string; op: string; price: number } | { error: string };
export type WatchlistResult = { ok: boolean; item: { symbol: string; deduped: boolean } } | { error: string };

export interface ToolDeps {
  getQuote(symbol: string, userId: string): Promise<ChatQuote>;
  searchKnowledge(args: { query: string; ticker?: string; doc_type?: string; as_of?: string; k?: number }, userId: string): Promise<KbChunk[]>;
  createAlert(userId: string, input: { symbol: string; op: string; price: number; note?: string }): AlertResult;
  watchlistAdd(userId: string, symbol: string): WatchlistResult;
  accountLabel?: string;
}

export interface ToolDef {
  readOnly: boolean;
  description: string;
  input_schema: Record<string, unknown>;
  execute(input: any, ctx: { userId: string; deps: ToolDeps }): Promise<any>;
}

const DRAFT_ORDER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["symbol", "side", "qty"],
  properties: {
    symbol: { type: "string" },
    side: { type: "string", enum: ["buy", "sell"] },
    qty: { type: "number" },
    order_type: { type: "string", enum: ["market", "limit"] },
    limit_usd: { type: ["number", "null"] },
    rationale: { type: "string" }
  }
};

export function buildTools(): Record<string, ToolDef> {
  return {
    get_quote: {
      readOnly: true,
      description: "Get the latest quote for a ticker. Use for price/quote questions.",
      input_schema: { type: "object", additionalProperties: false, required: ["symbol"], properties: { symbol: { type: "string" } } },
      async execute(input, ctx) {
        return ctx.deps.getQuote(canonicalTicker(String(input.symbol ?? "")), ctx.userId);
      }
    },

    draft_order: {
      readOnly: false, // creates a DRAFT only — still never executes
      description:
        "Prepare a DRAFT order ticket for the user to review. Does NOT place an order. Call when the " +
        "user clearly intends to buy/sell a specific instrument and quantity.",
      input_schema: DRAFT_ORDER_SCHEMA,
      async execute(input, ctx) {
        // Server-side validation — the model's input is untrusted regardless of any schema claim.
        const symbol = canonicalTicker(String(input.symbol ?? ""));
        const side = input.side === "sell" ? "sell" : "buy";
        const qty = Number(input.qty);
        const order_type = input.order_type === "limit" ? "limit" : "market";
        if (!symbol || !Number.isFinite(qty) || qty <= 0) return { error: "INVALID_DRAFT", details: "symbol and positive qty required" };
        const limit_usd = order_type === "market" || input.limit_usd == null ? null : Number(input.limit_usd);
        const draft: ChatDraft = {
          draft_id: randomUUID(),
          symbol,
          side,
          qty,
          order_type,
          limit_usd,
          rationale: typeof input.rationale === "string" ? input.rationale : "User requested this order.",
          account_label: ctx.deps.accountLabel ?? "Test (local)",
          is_real: false,
          blocked: false,
          warnings: [],
          executed: false
        };
        return draft;
      }
    },

    create_alert: {
      readOnly: false, // low-stakes + reversible — may create directly (no draft gate)
      description:
        "Create a price alert that notifies the user when a ticker crosses a threshold. Call when the " +
        "user asks to be alerted/notified when a symbol goes below/above a price.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["symbol", "op", "price"],
        properties: {
          symbol: { type: "string" },
          op: { type: "string", enum: ["<", ">", "below", "above"] },
          price: { type: "number" },
          note: { type: "string" }
        }
      },
      async execute(input, ctx) {
        return ctx.deps.createAlert(ctx.userId, {
          symbol: String(input.symbol ?? ""),
          op: String(input.op ?? ""),
          price: Number(input.price),
          note: typeof input.note === "string" ? input.note : undefined
        });
      }
    },

    kb_search: {
      readOnly: true,
      description:
        "Search the ingested knowledge base for filings, news, and notes. Answers must be grounded only " +
        "in returned chunks and cite them.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string" },
          ticker: { type: "string" },
          doc_type: { type: "string" },
          as_of: { type: "string" },
          k: { type: "integer", minimum: 1 }
        }
      },
      async execute(input, ctx) {
        const chunks = await ctx.deps.searchKnowledge(
          {
            query: String(input.query ?? ""),
            ticker: input.ticker ? canonicalTicker(String(input.ticker)) : undefined,
            doc_type: typeof input.doc_type === "string" ? input.doc_type : undefined,
            as_of: typeof input.as_of === "string" ? input.as_of : undefined,
            k: typeof input.k === "number" ? input.k : 5
          },
          ctx.userId
        );
        return { chunks };
      }
    },

    watchlist_add: {
      readOnly: false,
      description:
        "Add a ticker to the user watchlist. Reversible; does not draft or place orders. Call when the " +
        "user asks to watch, track, follow, or add a ticker to their watchlist.",
      input_schema: { type: "object", additionalProperties: false, required: ["symbol"], properties: { symbol: { type: "string" } } },
      async execute(input, ctx) {
        return ctx.deps.watchlistAdd(ctx.userId, String(input.symbol ?? ""));
      }
    }
  };
}
