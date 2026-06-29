// Apply pushed events from congress.trade (App A) — shared by the webhook route and the SSE client.
//
// App A pushes events (see docs/push-to-app-b.md). This module validates an event envelope, dedupes
// by id, and routes the payload into App B's existing persisted web-source datasets so the market
// scan's getSymbolWebSignals() overlay serves them with no other changes. Fully self-guarded.

import { coerceCongressTrade, upsertCongressTrades } from "./web-sources/congress";
import {
  coerceInsiderFiling,
  insiderFilingFromSentiment,
  upsertInsiderFilings,
  type InsiderFiling
} from "./web-sources/sec";
import type { CongressTrade } from "./web-sources/types";

export type CongressEventType = "congress.trade" | "insider.update" | "ref.upsert" | "price.eod" | "spx.eod";

export interface CongressEvent {
  type: CongressEventType | string;
  id?: string;
  // Monotonic per-stream sequence (forward-compat). Gap RECOVERY today is handled by the SSE client's
  // Last-Event-ID resume (replays missed events on reconnect) + id-dedupe; explicit seq-gap detection
  // with an automatic re-pull is deferred until App A's read endpoints are live. See docs/push-to-app-b.md.
  seq?: number;
  emittedAt?: string;
  data?: unknown;
}

export interface ApplyResult {
  ok: boolean;
  type?: string;
  applied: number; // rows actually written
  reason?: string;
  duplicate?: boolean;
}

// Bounded in-memory dedupe of event ids (idempotency across webhook retries / SSE reconnects).
// globalThis-pinned so Next.js HMR module duplication can't reset it.
const DEDUPE_CAP = 5000;
const dedupeHost = globalThis as unknown as { __congressEventIds?: Set<string> };
const seenIds: Set<string> = dedupeHost.__congressEventIds ?? (dedupeHost.__congressEventIds = new Set());

function markSeen(id: string): boolean {
  if (seenIds.has(id)) return false;
  if (seenIds.size >= DEDUPE_CAP) {
    // Evict ~half (oldest-ish: Set preserves insertion order) to bound memory.
    let toDrop = Math.floor(DEDUPE_CAP / 2);
    for (const v of seenIds) {
      seenIds.delete(v);
      if (--toDrop <= 0) break;
    }
  }
  seenIds.add(id);
  return true;
}

/** Test seam: clear the event-id dedupe set. */
export function resetCongressEventDedupe(): void {
  seenIds.clear();
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/**
 * Apply one pushed event. Never throws. Returns what was written. Unknown/empty event types and the
 * informational ref/price/spx events are acknowledged (ok:true) so App A's webhook gets a 2xx and
 * does not retry — App B consumes ref/price/spx lazily via the read client (congress-trade-client).
 */
export function applyCongressEvent(event: CongressEvent | null | undefined): ApplyResult {
  try {
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      return { ok: false, applied: 0, reason: "invalid-event" };
    }
    const type = event.type;
    if (typeof event.id === "string" && event.id && !markSeen(event.id)) {
      return { ok: true, type, applied: 0, duplicate: true };
    }
    const data = asRecord(event.data);

    if (type === "congress.trade") {
      const rawTrades = Array.isArray(data?.trades) ? (data!.trades as unknown[]) : [];
      const trades = rawTrades.map(coerceCongressTrade).filter((t): t is CongressTrade => t !== null);
      if (trades.length === 0) return { ok: true, type, applied: 0, reason: "no-trades" };
      const { added } = upsertCongressTrades(trades);
      return { ok: true, type, applied: added };
    }

    if (type === "insider.update") {
      let filings: InsiderFiling[] = [];
      if (Array.isArray(data?.filings)) {
        filings = (data!.filings as unknown[]).map(coerceInsiderFiling).filter((f): f is InsiderFiling => f !== null);
      } else if (data && typeof data.insiderSentiment === "number" && typeof data.ticker === "string") {
        const marker = insiderFilingFromSentiment(
          data.ticker,
          data.insiderSentiment,
          typeof data.asOf === "string" ? data.asOf : undefined
        );
        if (marker) filings = [marker];
      }
      if (filings.length === 0) return { ok: true, type, applied: 0, reason: "no-filings" };
      const { total } = upsertInsiderFilings(filings);
      return { ok: true, type, applied: filings.length, reason: `dataset=${total}` };
    }

    if (type === "ref.upsert" || type === "price.eod" || type === "spx.eod") {
      // Informational: App B pulls refs/prices/spx lazily via the read client on next fetch.
      return { ok: true, type, applied: 0, reason: "accepted-noop" };
    }

    return { ok: false, type, applied: 0, reason: "unknown-type" };
  } catch (err) {
    console.error("[congress-events] apply error:", err);
    return { ok: false, applied: 0, reason: err instanceof Error ? err.message : "error" };
  }
}

/** Apply a batch of events; returns per-event results. */
export function applyCongressEvents(events: unknown): ApplyResult[] {
  if (!Array.isArray(events)) return [];
  return events.map((e) => applyCongressEvent(e as CongressEvent));
}
