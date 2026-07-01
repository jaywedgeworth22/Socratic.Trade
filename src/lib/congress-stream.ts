// Persistent SSE consumer for congress.trade (App A). Connects OUT to App A's text/event-stream and
// applies pushed events (see docs/push-to-app-b.md) — the streaming counterpart to the inbound
// /api/webhooks/congress route. Must run in the persistent Node process (started from
// instrumentation.register via startStreams(), NOT a per-request handler).
//
// Reconnects with exponential backoff and resumes via the Last-Event-ID header so events aren't
// lost across reconnects. Opt-in (CONGRESS_STREAM_ENABLED); no-op otherwise. Fully self-guarded.

import { applyCongressEvent, type CongressEvent } from "./congress-trade-events";
import { logApiHealth } from "./db-health";

const DEFAULT_PATH = "/api/stream";
const MAX_BACKOFF_MS = 60_000;
const INITIAL_BACKOFF_MS = 1_000;

interface StreamState {
  started: boolean;
  closing: boolean;
  backoffMs: number;
  lastEventId?: string;
  controller?: AbortController;
}

const host = globalThis as unknown as { __congressStream?: StreamState };
const state: StreamState = host.__congressStream ?? (host.__congressStream = { started: false, closing: false, backoffMs: INITIAL_BACKOFF_MS });

export function congressStreamEnabled(): boolean {
  return ["1", "true", "on", "yes"].includes(String(process.env.CONGRESS_STREAM_ENABLED ?? "").trim().toLowerCase());
}

function streamUrl(): string {
  const base = (process.env.CONGRESS_TRADE_BASE_URL ?? "https://congress.trade").trim().replace(/\/+$/, "");
  const path = (process.env.CONGRESS_STREAM_PATH ?? DEFAULT_PATH).trim();
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function readToken(): string | undefined {
  const t = (process.env.CONGRESS_TRADE_READ_TOKEN ?? "").trim();
  return t.length > 0 ? t : undefined;
}

// ── Pure SSE frame parser (unit-tested; no network) ──────────────────────────
export interface SseMessage {
  event?: string;
  id?: string;
  data: string;
}

/** Incremental text/event-stream parser. Feed decoded chunks; get back complete events. */
export class SseParser {
  private buf = "";
  private cur: { event?: string; id?: string; data: string[] } = { data: [] };

  push(chunk: string): SseMessage[] {
    this.buf += chunk;
    const out: SseMessage[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (this.cur.data.length > 0 || this.cur.event !== undefined || this.cur.id !== undefined) {
          out.push({ event: this.cur.event, id: this.cur.id, data: this.cur.data.join("\n") });
        }
        this.cur = { data: [] };
        continue;
      }
      if (line.startsWith(":")) continue; // comment / heartbeat
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") this.cur.data.push(value);
      else if (field === "event") this.cur.event = value;
      else if (field === "id") this.cur.id = value;
      // "retry" and unknown fields ignored
    }
    return out;
  }
}

/** Parse one SSE message's JSON envelope and apply it. Returns false on unparseable data. */
export function applySseMessage(msg: SseMessage): boolean {
  if (!msg.data) return false;
  let env: CongressEvent;
  try {
    env = JSON.parse(msg.data) as CongressEvent;
  } catch {
    return false;
  }
  if (!env || typeof env !== "object") return false;
  if (!env.type && msg.event) env.type = msg.event;
  if (!env.id && msg.id) env.id = msg.id;
  applyCongressEvent(env);
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectOnce(): Promise<void> {
  const controller = new AbortController();
  state.controller = controller;
  const token = readToken();
  const startedAt = Date.now();
  const res = await fetch(streamUrl(), {
    headers: {
      accept: "text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(state.lastEventId ? { "last-event-id": state.lastEventId } : {})
    },
    cache: "no-store",
    signal: controller.signal
  });
  if (!res.ok || !res.body) throw new Error(`SSE connect failed: HTTP ${res.status}`);
  state.backoffMs = INITIAL_BACKOFF_MS; // healthy connection → reset backoff
  // Connection-health signal for the admin Connections page (App B's side of the
  // App A → App B real-time link). Re-fires on each (re)connect within App A's
  // ~25min stream lifetime; connection failures log ok:false below.
  logApiHealth({ service: "congress.trade:sse", ok: true, latencyMs: Date.now() - startedAt });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
      if (msg.id) state.lastEventId = msg.id; // resume point — replayed via Last-Event-ID on reconnect
      if (!applySseMessage(msg)) {
        console.warn("[congress-stream] dropped unparseable SSE message", { event: msg.event, id: msg.id });
      }
    }
    if (state.closing) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
  }
}

async function runLoop(): Promise<void> {
  while (!state.closing) {
    try {
      await connectOnce();
    } catch (err) {
      console.error("[congress-stream] connection error:", err instanceof Error ? err.message : err);
      logApiHealth({
        service: "congress.trade:sse",
        ok: false,
        errorText: err instanceof Error ? err.message : String(err),
      });
    }
    if (state.closing) break;
    await sleep(state.backoffMs);
    state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
  }
}

/** Idempotent: start the SSE consumer once if enabled. */
export function startCongressStream(): void {
  if (state.started || state.closing) return;
  if (!congressStreamEnabled()) return;
  if (typeof fetch === "undefined") {
    console.warn("[congress-stream] global fetch unavailable; not starting.");
    return;
  }
  state.started = true;
  void runLoop();
}

/** Stop the consumer (tests / graceful shutdown). */
export function stopCongressStream(): void {
  state.closing = true;
  try {
    state.controller?.abort();
  } catch {
    /* ignore */
  }
}
