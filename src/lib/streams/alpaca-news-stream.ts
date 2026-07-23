// Persistent Alpaca news WebSocket worker (free Benzinga feed). Connects OUT and holds a
// long-lived socket — the inverse of the inbound TradingView webhook — so it must run in the
// persistent Node process (started from instrumentation.register, NOT a per-request handler).
//
// Flow per Alpaca's protocol: connect → server sends {T:"success",msg:"connected"} → we send
// auth → {T:"success",msg:"authenticated"} → we subscribe news:["*"] → {T:"n",...} articles.
// On each article we write headlines into the push store; the enrichment provider reads it.
// Reconnects with exponential backoff; dedups by article id. Opt-in (STREAMS_ALPACA_NEWS_ENABLED).

import { resolveAlpacaStreamAccount } from "../db";
import { recordStreamedArticle } from "./news-store";

const ALPACA_NEWS_WS = process.env.ALPACA_NEWS_WS_URL || "wss://stream.data.alpaca.markets/v1beta1/news";
const MAX_BACKOFF_MS = 60_000;

interface StreamState {
  ws?: WebSocket;
  started: boolean;
  closing: boolean;
  backoffMs: number;
}

const globalForStream = globalThis as unknown as { __alpacaNewsStream?: StreamState };
const state: StreamState =
  globalForStream.__alpacaNewsStream ?? (globalForStream.__alpacaNewsStream = { started: false, closing: false, backoffMs: 1000 });

export function alpacaNewsStreamEnabled(): boolean {
  return ["1", "true", "on", "yes"].includes(String(process.env.STREAMS_ALPACA_NEWS_ENABLED ?? "").trim().toLowerCase());
}

/** Idempotent: starts the worker once if enabled and Alpaca keys are present. */
export function startAlpacaNewsStream(): void {
  if (state.started || state.closing) return;
  if (!alpacaNewsStreamEnabled()) return;
  if (typeof WebSocket === "undefined") {
    console.warn("[stream:alpaca-news] global WebSocket unavailable in this runtime; not starting.");
    return;
  }
  // Process-level background worker (no per-request user): keyed to the `local` operator's
  // active connected Alpaca account (falls back to the legacy standalone key pair).
  const creds = resolveAlpacaStreamAccount("local");
  if (!creds) {
    console.warn("[stream:alpaca-news] missing Alpaca key; not starting.");
    return;
  }
  state.started = true;
  connect(creds.apiKey, creds.apiSecret);
}

function connect(key: string, secret?: string): void {
  if (state.closing) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(ALPACA_NEWS_WS);
  } catch {
    scheduleReconnect(key, secret);
    return;
  }
  state.ws = ws;

  ws.onmessage = (event: MessageEvent) => {
    let messages: unknown;
    try {
      messages = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    if (!Array.isArray(messages)) return;
    for (const raw of messages) {
      const m = raw as Record<string, unknown>;
      const t = m.T;
      if (t === "success" && m.msg === "connected") {
        if (secret) {
          ws.send(JSON.stringify({ action: "auth", key, secret }));
        } else {
          ws.send(JSON.stringify({ action: "auth", key: "oauth", secret: key }));
        }
      } else if (t === "success" && m.msg === "authenticated") {
        ws.send(JSON.stringify({ action: "subscribe", news: ["*"] }));
        state.backoffMs = 1000; // reset after a clean auth
        console.log("[stream:alpaca-news] authenticated + subscribed to news.");
      } else if (t === "n") {
        const headline = typeof m.headline === "string" ? m.headline : "";
        const symbols = Array.isArray(m.symbols) ? (m.symbols as unknown[]).map(String) : [];
        if (headline && symbols.length > 0) recordStreamedArticle(symbols, headline, String(m.id ?? ""));
      } else if (t === "error") {
        console.warn("[stream:alpaca-news] error frame:", m.msg ?? JSON.stringify(m));
      }
    }
  };

  ws.onerror = () => {
    // onclose fires next and handles reconnect.
  };
  ws.onclose = () => {
    state.ws = undefined;
    scheduleReconnect(key, secret);
  };
}

function scheduleReconnect(key: string, secret?: string): void {
  if (state.closing) return;
  const delay = Math.min(state.backoffMs, MAX_BACKOFF_MS);
  state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
  setTimeout(() => connect(key, secret), delay);
}

export function stopAlpacaNewsStream(): void {
  state.closing = true;
  try {
    state.ws?.close();
  } catch {
    // ignore
  }
}
