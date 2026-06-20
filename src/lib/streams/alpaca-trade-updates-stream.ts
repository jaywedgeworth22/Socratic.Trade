// Persistent Alpaca trade_updates (account/fill) WebSocket worker. Mirrors the news worker, but
// hits the TRADING host with a different auth/subscribe handshake and BINARY frames (whose payload
// is still JSON — no msgpack — and a single object, not the array the news stream sends).
//
// On a fill / partial_fill it runs the deterministic fill handler (reconcile + dashboard refresh).
// Opt-in (STREAMS_ALPACA_TRADE_UPDATES_ENABLED); no-op without Alpaca keys.

import { resolveApiKey } from "../db";
import { onBrokerFill } from "../fills";

const TRADE_WS_URL = process.env.ALPACA_TRADE_WS_URL || "wss://paper-api.alpaca.markets/stream";
const MAX_BACKOFF_MS = 60_000;

interface StreamState {
  ws?: WebSocket;
  started: boolean;
  closing: boolean;
  backoffMs: number;
  seen: Set<string>;
}

const globalForStream = globalThis as unknown as { __alpacaTradeStream?: StreamState };
const state: StreamState =
  globalForStream.__alpacaTradeStream ?? (globalForStream.__alpacaTradeStream = { started: false, closing: false, backoffMs: 1000, seen: new Set() });

export function alpacaTradeUpdatesEnabled(): boolean {
  return ["1", "true", "on", "yes"].includes(String(process.env.STREAMS_ALPACA_TRADE_UPDATES_ENABLED ?? "").trim().toLowerCase());
}

export function startAlpacaTradeUpdatesStream(): void {
  if (state.started || state.closing) return;
  if (!alpacaTradeUpdatesEnabled()) return;
  if (typeof WebSocket === "undefined") {
    console.warn("[stream:alpaca-trades] global WebSocket unavailable; not starting.");
    return;
  }
  const key = resolveApiKey("alpaca_paper_api_key");
  const secret = resolveApiKey("alpaca_paper_secret_key");
  if (!key) {
    console.warn("[stream:alpaca-trades] missing Alpaca API key; not starting.");
    return;
  }
  state.started = true;
  connect(key, secret || undefined);
}

function connect(key: string, secret?: string): void {
  if (state.closing) return;
  let ws: WebSocket;
  try {
    ws = new WebSocket(TRADE_WS_URL);
  } catch {
    scheduleReconnect(key, secret);
    return;
  }
  ws.binaryType = "arraybuffer";
  state.ws = ws;

  ws.onopen = () => {
    try {
      if (secret) {
        ws.send(JSON.stringify({ action: "auth", key, secret }));
      } else {
        ws.send(JSON.stringify({ action: "auth", key: "oauth", secret: key }));
      }
    } catch {
      // onclose will reconnect
    }
  };

  ws.onmessage = (event: MessageEvent) => {
    let msg: Record<string, unknown>;
    try {
      const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const stream = msg.stream;
    if (stream === "authorization") {
      const data = (msg.data ?? {}) as Record<string, unknown>;
      if (data.status === "authorized") {
        ws.send(JSON.stringify({ action: "listen", data: { streams: ["trade_updates"] } }));
        state.backoffMs = 1000;
        console.log("[stream:alpaca-trades] authorized + listening to trade_updates.");
      } else {
        console.warn("[stream:alpaca-trades] auth not authorized:", JSON.stringify(data));
      }
    } else if (stream === "trade_updates") {
      const data = (msg.data ?? {}) as Record<string, unknown>;
      const ev = String(data.event ?? "");
      if (ev !== "fill" && ev !== "partial_fill") return;
      const order = (data.order ?? {}) as Record<string, unknown>;
      const orderId = String(order.id ?? "");
      const symbol = order.symbol ? String(order.symbol) : undefined;
      const dedup = `${orderId}:${ev}:${String(data.timestamp ?? "")}`;
      if (state.seen.has(dedup)) return;
      state.seen.add(dedup);
      if (state.seen.size > 500) state.seen = new Set(Array.from(state.seen).slice(-250));
      void onBrokerFill({ orderId, symbol, event: ev }).catch((e) => console.error("[stream:alpaca-trades] fill handler:", e));
    }
  };

  ws.onerror = () => {
    // onclose handles reconnect
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

export function stopAlpacaTradeUpdatesStream(): void {
  state.closing = true;
  try {
    state.ws?.close();
  } catch {
    // ignore
  }
}
