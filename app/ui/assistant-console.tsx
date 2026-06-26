"use client";

// AI Assistant console (the "manual AI order placement" surface). The user converses; the chat
// backend (POST /api/chat) may return a draft order ticket; the user runs a policy dry-run, stages
// it as a real `proposed` TradeProposal (POST /api/proposals/from-draft), then confirms inline —
// which calls the EXISTING approve→executeProposal rail. The assistant never executes on its own.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import type { ExecutionState } from "@/lib/execution-mode";
import { humanizeLlmError } from "@/lib/llm-errors";
import { Button, Card, Chip, EmptyState, inputClass } from "./primitives";
import { Markdown } from "./markdown";
import { cn } from "./cn";

interface ChatDraft {
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
  executed: boolean;
}
interface Citation {
  source: string;
  chunk_id?: string;
  as_of?: string;
  url?: string;
}
interface ChatReply {
  text: string;
  draft: ChatDraft | null;
  citations: Citation[];
  intent: string;
}
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
  draft?: ChatDraft | null;
}

type DraftPhase = "draft" | "checking" | "checked" | "sending" | "proposed" | "placing" | "done" | "rejecting" | "rejected" | "discarded";
interface DraftState {
  phase: DraftPhase;
  decision?: { approved: boolean; reasons: string[] };
  estimatedNotional?: number;
  proposalId?: string;
}

function destination(state: ExecutionState): { text: string; tone: "info" | "up" | "down"; live: boolean } {
  if (state.mode === "broker/live") return { text: `Brokerage live${state.accountLabel ? " · " + state.accountLabel : ""} · real money`, tone: "down", live: true };
  if (state.mode === "broker/paper") return { text: `Paper${state.accountLabel ? " · " + state.accountLabel : ""} · broker sandbox`, tone: "up", live: false };
  return { text: "Test · local simulation", tone: "info", live: false };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

async function readPlainError(res: Response, fallback: string): Promise<Error> {
  const raw = await res.text().catch(() => "");
  let message = raw.trim();
  try {
    const parsed = JSON.parse(message) as { error?: unknown; summary?: unknown; message?: unknown };
    if (typeof parsed.summary === "string") message = parsed.summary;
    else if (typeof parsed.message === "string") message = parsed.message;
    else if (typeof parsed.error === "string") message = parsed.error;
    else if (parsed.error && typeof parsed.error === "object" && "error" in parsed.error && typeof (parsed.error as { error?: unknown }).error === "string") {
      message = String((parsed.error as { error: string }).error);
    }
  } catch {
    if (message.startsWith("<")) message = "";
  }
  // Turn a raw provider error (e.g. "gemini 401: API key not valid") into a plain-English,
  // provider-aware sentence. The provider + HTTP status are parsed from the message text itself
  // (the route's own status is 500, so we don't pass it).
  if (message) message = humanizeLlmError(message);
  return new Error(message || `${fallback} (${res.status}).`);
}

// Router-matched suggested prompts (co-versioned with classifyIntent so a chip never dead-ends).
// NB: knowledge example says 8-K, not 10-K — only 8-K catalysts are indexed today.
const SUGGESTIONS: Array<{ category: string; prompt: string }> = [
  { category: "Ask", prompt: "What is AAPL trading at?" },
  { category: "Knowledge", prompt: "Any recent 8-K catalysts for TSLA?" },
  { category: "Portfolio", prompt: "How are my positions doing?" },
  { category: "Watchlist", prompt: "What's on my watchlist?" },
  { category: "Alert", prompt: "Alert me if AAPL drops below 180" },
  { category: "Track", prompt: "Add NVDA to my watchlist" },
  { category: "Draft", prompt: "Draft a buy of 10 AAPL at 200" }
];

// Chat-model selector: pick any of the five providers. The chosen model is sent as a per-request
// `model` hint to /api/chat, which routes it to the right provider by name (claude-*→Anthropic,
// grok-*→xAI, gemini-*→Gemini, mistral-*→Mistral, else OpenAI). A few recommended models per
// provider, spanning cost ↔ capability. Selection is sticky via localStorage (no DB migration).
// Per-provider key availability is fetched from /api/chat/providers; a provider without a usable key
// is labeled "— no key" and its options disabled (offline Mock is always available).
type ChatProviderId = "openai" | "anthropic" | "xai" | "gemini" | "mistral";

const CHAT_MODEL_GROUPS: Array<{ label: string; provider?: ChatProviderId; options: Array<{ value: string; label: string }> }> = [
  { label: "Offline", options: [{ value: "mock", label: "Mock — deterministic, no key" }] },
  {
    label: "OpenAI",
    provider: "openai",
    options: [
      { value: "gpt-5.4-nano", label: "gpt-5.4-nano — lowest cost, fastest" },
      { value: "gpt-5.4-mini", label: "gpt-5.4-mini — balanced default" },
      { value: "gpt-5.4", label: "gpt-5.4 — strongest, higher cost" }
    ]
  },
  {
    label: "Anthropic",
    provider: "anthropic",
    options: [
      { value: "claude-haiku-4-5", label: "claude-haiku-4-5 — fast & low cost" },
      { value: "claude-sonnet-4-6", label: "claude-sonnet-4-6 — stronger reasoning" },
      { value: "claude-opus-4-8", label: "claude-opus-4-8 — strongest, premium" }
    ]
  },
  {
    label: "xAI (Grok)",
    provider: "xai",
    options: [
      { value: "grok-build-0.1", label: "grok-build-0.1 — lowest cost" },
      { value: "grok-4.3", label: "grok-4.3 — stronger, large context" }
    ]
  },
  {
    label: "Google Gemini",
    provider: "gemini",
    options: [
      { value: "gemini-2.5-flash-lite", label: "gemini-2.5-flash-lite — lowest cost" },
      { value: "gemini-2.5-flash", label: "gemini-2.5-flash — balanced, long context" },
      { value: "gemini-3.5-flash", label: "gemini-3.5-flash — strongest flash" }
    ]
  },
  {
    label: "Mistral",
    provider: "mistral",
    options: [
      { value: "mistral-small-latest", label: "mistral-small-latest — lowest cost" },
      { value: "mistral-medium-latest", label: "mistral-medium-latest — balanced" },
      { value: "mistral-large-latest", label: "mistral-large-latest — strongest" }
    ]
  }
];

const DEFAULT_CHAT_MODEL = "gpt-5.4-mini";
const CHAT_MODEL_STORAGE_KEY = "assistant.chatModel";

export function AssistantView({
  executionState,
  approveProposal,
  rejectProposal,
  defaultModel
}: {
  executionState: ExecutionState;
  approveProposal: (proposalId: string) => Promise<void>;
  rejectProposal: (proposalId: string) => Promise<void>;
  /** Initial chat model. Overridden by a sticky localStorage choice; defaults to gpt-5.4-mini. */
  defaultModel?: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [model, setModel] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const saved = window.localStorage.getItem(CHAT_MODEL_STORAGE_KEY);
      if (saved) return saved;
    }
    return defaultModel ?? DEFAULT_CHAT_MODEL;
  });
  // Per-provider key availability for the picker. undefined = not yet loaded (treat as available so we
  // never flash "no key" before the check resolves); after load, false = no usable key for that provider.
  const [providerStatus, setProviderStatus] = useState<Partial<Record<ChatProviderId, boolean>>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dest = destination(executionState);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/chat-history?limit=50");
        if (!res.ok) return;
        const body = (await res.json()) as { turns: Array<{ id: string; role: "user" | "assistant"; text: string }> };
        if (!cancelled) setMessages(body.turns.map((t) => ({ id: t.id, role: t.role, text: t.text })));
      } catch {
        /* history is best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Which providers have a usable key (so the picker can mark/disable ones that don't). Fail open:
  // on error, leave statuses unset → every provider stays selectable.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/chat/providers");
        if (!res.ok) return;
        const body = (await res.json()) as { providers?: Partial<Record<ChatProviderId, boolean>> };
        if (!cancelled && body.providers) setProviderStatus(body.providers);
      } catch {
        /* availability is best-effort; default to all selectable */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, drafts]);

  // Persist the chat-model choice so it survives reloads (client-side only — no DB migration).
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(CHAT_MODEL_STORAGE_KEY, model);
  }, [model]);

  const patchDraft = (msgId: string, patch: Partial<DraftState>) =>
    setDrafts((d) => ({ ...d, [msgId]: { ...(d[msgId] ?? { phase: "draft" }), ...patch } as DraftState }));

  const send = useCallback(async (override?: string) => {
    const message = (typeof override === "string" ? override : input).trim();
    if (!message || sending) return;
    setInput("");
    const stamp = Date.now();
    setMessages((m) => [...m, { id: `u-${stamp}`, role: "user", text: message }]);
    setSending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, model })
      });
      if (!res.ok) throw await readPlainError(res, "Chat request failed");
      const reply = (await res.json()) as ChatReply;
      const id = `a-${stamp}`;
      setMessages((m) => [...m, { id, role: "assistant", text: reply.text, citations: reply.citations, draft: reply.draft }]);
      if (reply.draft) setDrafts((d) => ({ ...d, [id]: { phase: "draft" } }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Chat request failed.");
      setMessages((m) => [...m, { id: `e-${stamp}`, role: "assistant", text: "Sorry — something went wrong handling that." }]);
    } finally {
      setSending(false);
    }
  }, [input, model, sending]);

  async function checkPolicy(msgId: string, draft: ChatDraft) {
    patchDraft(msgId, { phase: "checking" });
    try {
      const res = await fetch("/api/proposals/from-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft, dryRun: true })
      });
      const body = await readJson(res);
      if (!res.ok) {
        const reasons = (body.reasons as string[]) ?? [(body.error as string) ?? "Rejected."];
        patchDraft(msgId, { phase: "checked", decision: { approved: false, reasons } });
        return;
      }
      patchDraft(msgId, {
        phase: "checked",
        decision: body.decision as { approved: boolean; reasons: string[] },
        estimatedNotional: body.estimatedNotional as number | undefined
      });
    } catch (e) {
      patchDraft(msgId, { phase: "checked", decision: { approved: false, reasons: [e instanceof Error ? e.message : "Policy check failed."] } });
    }
  }

  async function sendToApprovals(msgId: string, draft: ChatDraft) {
    patchDraft(msgId, { phase: "sending" });
    try {
      const res = await fetch("/api/proposals/from-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft })
      });
      const body = await readJson(res);
      if (!res.ok) {
        const reasons = (body.reasons as string[]) ?? [(body.error as string) ?? "Could not stage."];
        toast.warning("Could not stage the order", { description: reasons.join("\n") });
        patchDraft(msgId, { phase: "checked", decision: { approved: false, reasons } });
        return;
      }
      patchDraft(msgId, { phase: "proposed", proposalId: body.proposalId as string, estimatedNotional: body.estimatedNotional as number | undefined });
      toast.success("Staged — confirm to place.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Staging failed.");
      patchDraft(msgId, { phase: "checked" });
    }
  }

  async function confirmPlace(msgId: string, proposalId: string) {
    patchDraft(msgId, { phase: "placing" });
    try {
      await approveProposal(proposalId); // existing rail: re-evaluates + executes (paper/live) + toasts + reloads
      patchDraft(msgId, { phase: "done" });
    } catch {
      patchDraft(msgId, { phase: "proposed" });
    }
  }

  async function rejectStaged(msgId: string, proposalId: string) {
    patchDraft(msgId, { phase: "rejecting" });
    try {
      await rejectProposal(proposalId); // existing rail: marks the proposed row rejected + toasts + reloads
      patchDraft(msgId, { phase: "rejected" });
    } catch {
      patchDraft(msgId, { phase: "proposed" });
    }
  }

  return (
    <Card className="flex h-full min-h-[28rem] flex-col p-0">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-accent" />
          <span className="text-sm font-medium text-fg">Assistant</span>
          <span className="text-xs text-muted">drafts orders you confirm — it never places on its own</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              // Move focus straight to the prompt box so the user can type right after picking a model.
              inputRef.current?.focus();
            }}
            className="max-w-[15rem] rounded-md border border-line bg-surface px-2 py-1 text-xs text-fg focus:outline-none focus:ring-1 focus:ring-accent"
            title="Chat model — pick any provider. Providers without a key are marked “no key” and disabled; manage keys in Settings → Connections."
          >
            {CHAT_MODEL_GROUPS.map((g) => {
              // A provider with an explicit `false` status has no usable key — label it and disable
              // its options. `undefined` (not yet loaded) or no provider (Offline) stays available.
              const missing = g.provider ? providerStatus[g.provider] === false : false;
              return (
                <optgroup key={g.label} label={missing ? `${g.label} — no key` : g.label}>
                  {g.options.map((o) => (
                    <option key={o.value} value={o.value} disabled={missing}>{o.label}</option>
                  ))}
                </optgroup>
              );
            })}
          </select>
          <Chip tone={dest.tone}>{dest.text}</Chip>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <div className="grid h-full place-items-center">
            <div className="max-w-xl text-center">
              <EmptyState
                icon={<Sparkles size={18} />}
                title="Ask the assistant"
                hint="Try one of these — orders always come back as a draft you confirm."
              />
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.prompt}
                    onClick={() => void send(s.prompt)}
                    disabled={sending}
                    className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-fg transition hover:border-accent hover:bg-surface-2 disabled:opacity-50"
                  >
                    <span className="text-[10px] uppercase tracking-wide text-muted">{s.category}</span>
                    <span className="ml-1.5">{s.prompt}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[42rem] rounded-lg px-3 py-2 text-sm", m.role === "user" ? "bg-accent/15 text-fg" : "bg-surface-2 text-fg")}>
              {m.role === "assistant" ? (
                <Markdown>{m.text}</Markdown>
              ) : (
                <p className="whitespace-pre-wrap leading-relaxed">{m.text}</p>
              )}
              {m.citations && m.citations.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {m.citations.map((c, i) =>
                    c.url ? (
                      <a key={i} href={c.url} target="_blank" rel="noopener noreferrer">
                        <Chip tone="neutral" className="text-[10px] underline decoration-dotted">
                          {c.chunk_id ?? c.source}
                        </Chip>
                      </a>
                    ) : (
                      <Chip key={i} tone="neutral" className="text-[10px]">
                        {c.chunk_id ?? c.source}
                      </Chip>
                    )
                  )}
                </div>
              )}
              {m.draft && (
                <DraftOrderCard
                  draft={m.draft}
                  state={drafts[m.id] ?? { phase: "draft" }}
                  dest={dest}
                  onCheck={() => checkPolicy(m.id, m.draft!)}
                  onSend={() => sendToApprovals(m.id, m.draft!)}
                  onConfirm={(pid) => confirmPlace(m.id, pid)}
                  onReject={(pid) => rejectStaged(m.id, pid)}
                  onDiscard={() => patchDraft(m.id, { phase: "discarded" })}
                />
              )}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 size={14} className="animate-spin" /> thinking…
          </div>
        )}
      </div>

      <div className="border-t border-line p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            className={cn(inputClass, "min-h-[2.5rem] flex-1 resize-none")}
            rows={1}
            placeholder="Ask a question, or describe an order to draft…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button onClick={() => void send()} disabled={sending || !input.trim()} size="md">
            <Send size={15} /> Send
          </Button>
        </div>
      </div>
    </Card>
  );
}

function money(n: number | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—";
}

function DraftOrderCard({
  draft,
  state,
  dest,
  onCheck,
  onSend,
  onConfirm,
  onReject,
  onDiscard
}: {
  draft: ChatDraft;
  state: DraftState;
  dest: { text: string; tone: "info" | "up" | "down"; live: boolean };
  onCheck: () => void;
  onSend: () => void;
  onConfirm: (proposalId: string) => void;
  onReject: (proposalId: string) => void;
  onDiscard: () => void;
}) {
  if (state.phase === "discarded") {
    return <div className="mt-2 rounded-md border border-line bg-surface px-3 py-1.5 text-xs text-muted">Draft discarded.</div>;
  }
  const sideUp = draft.side.toUpperCase();
  const orderLine = `${sideUp} ${draft.qty} ${draft.symbol} · ${draft.order_type}${draft.order_type === "limit" && draft.limit_usd != null ? ` @ $${draft.limit_usd}` : ""}`;
  const blocked = state.decision && !state.decision.approved;

  return (
    <div className="mt-2 rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-medium text-fg">{orderLine}</span>
        <Chip tone={dest.tone}>{dest.text}</Chip>
      </div>
      {draft.rationale && <p className="mt-1 text-xs text-muted">{draft.rationale}</p>}

      {state.decision && (
        <div className={cn("mt-2 rounded-md px-2.5 py-1.5 text-xs", blocked ? "bg-down/10 text-down" : "bg-up/10 text-up")}>
          <div className="flex items-center gap-1.5 font-medium">
            {blocked ? <AlertTriangle size={13} /> : <ShieldCheck size={13} />}
            {blocked ? "Blocked by policy" : "Passes policy"} {state.estimatedNotional != null && <span className="text-muted">· est. {money(state.estimatedNotional)}</span>}
          </div>
          {blocked && state.decision.reasons.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-down/90">
              {state.decision.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {(state.phase === "draft" || state.phase === "checking" || state.phase === "checked") && (
          <>
            <Button size="sm" variant="subtle" onClick={onCheck} disabled={state.phase === "checking"}>
              {state.phase === "checking" ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Check policy
            </Button>
            {state.phase === "checked" && !blocked && (
              <Button size="sm" onClick={onSend}>
                Stage for approval
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onDiscard}>
              <X size={13} /> Discard
            </Button>
          </>
        )}

        {state.phase === "sending" && (
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Loader2 size={13} className="animate-spin" /> staging…
          </span>
        )}

        {state.phase === "proposed" && state.proposalId && (
          <>
            <Button size="sm" variant={dest.live ? "danger" : "primary"} onClick={() => onConfirm(state.proposalId!)}>
              <Check size={13} /> {dest.live ? `Confirm — places a REAL order against ${draft.symbol}` : "Confirm & place"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onReject(state.proposalId!)}>
              <X size={13} /> Reject
            </Button>
            <span className="text-[11px] text-muted">also in the Decision tab</span>
          </>
        )}

        {state.phase === "placing" && (
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Loader2 size={13} className="animate-spin" /> placing…
          </span>
        )}

        {state.phase === "rejecting" && (
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Loader2 size={13} className="animate-spin" /> rejecting…
          </span>
        )}

        {state.phase === "done" && (
          <span className="flex items-center gap-1.5 text-xs text-up">
            <Check size={14} /> Submitted via the approvals rail.
          </span>
        )}

        {state.phase === "rejected" && (
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <X size={14} /> Rejected.
          </span>
        )}
      </div>
    </div>
  );
}
