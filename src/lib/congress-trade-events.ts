// Apply pushed events from congress.trade (App A) — shared by the webhook route and the SSE client.
//
// App A pushes events (see docs/push-to-app-b.md). This module validates an event envelope, dedupes
// by id, and routes the payload into App B's existing persisted web-source datasets so the market
// scan's getSymbolWebSignals() overlay serves them with no other changes. Fully self-guarded.

import {
  type CongressEvent,
  type CongressEventType,
  CongressEventSchema,
  parseSafe,
} from "@jaywedgeworth22/congress-trading-shared";
import { coerceCongressTrade, upsertCongressTrades } from "./web-sources/congress";
import {
  coerceInsiderFiling,
  insiderFilingFromSentiment,
  upsertInsiderFilings,
  type InsiderFiling
} from "./web-sources/sec";
import type { CongressTrade } from "./web-sources/types";

export type { CongressEventType, CongressEvent };

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
    const raw = asRecord(event);
    if (!raw) return { ok: false, applied: 0, reason: "invalid-event" };

    // Resolve the event type, tolerating App A's wire variants (Postel's law —
    // App B must ingest whatever App A actually sends across the rollout window):
    //  - the canonical contract `type` field,
    //  - the legacy `event` field (App A's webhook posts { event: 'trade.new', transaction }
    //    and its pre-fix SSE emitted `event: trade.new`), and
    //  - `trade.new` is treated as an alias of the canonical `congress.trade`.
    const rawType =
      typeof raw.type === "string" && raw.type
        ? raw.type
        : typeof raw.event === "string" && raw.event
          ? raw.event
          : "";
    if (!rawType) return { ok: false, applied: 0, reason: "invalid-event" };
    const type = rawType === "trade.new" ? "congress.trade" : rawType;

    // Best-effort shape validation (non-blocking): normalize the type first so a
    // legacy `event`-keyed envelope still passes the schema.
    const validated = parseSafe(CongressEventSchema, { ...raw, type });
    if (!validated) {
      console.warn("[congress-events] event validation failed, using raw event");
    }
    const id = typeof raw.id === "string" ? raw.id : undefined;
    if (id && !markSeen(id)) {
      return { ok: true, type, applied: 0, duplicate: true };
    }
    const data = asRecord(raw.data);

    if (type === "congress.trade") {
      // Collect trade rows from every shape App A may send on either channel:
      //  - contract envelope:   data.trades: [...]
      //  - flattened SSE frame: top-level trades: [...] (the `data:` line is the payload)
      //  - single-tx webhook:   top-level transaction / data.transaction
      //  - last resort:         the envelope itself is one trade (legacy bare-tx SSE)
      const candidates: unknown[] = [];
      if (Array.isArray(data?.trades)) candidates.push(...(data!.trades as unknown[]));
      if (Array.isArray(raw.trades)) candidates.push(...(raw.trades as unknown[]));
      const single = raw.transaction ?? data?.transaction;
      if (single) candidates.push(single);
      if (candidates.length === 0) {
        // Last resort: the envelope itself is one bare transaction (legacy bare-tx SSE). Strip the
        // envelope-level fields first — applySseMessage copies the SSE event name into `raw.type`, and
        // `coerceCongressTrade` reads `type` BEFORE `txType` for the side, so leaving `type` in place
        // would shadow a valid `txType: "P"/"S"` row and reject it as no-trades. `event`/`id`/`data`
        // are likewise envelope fields, never transaction-side data.
        const bareTx: Record<string, unknown> = { ...raw };
        delete bareTx.type;
        delete bareTx.event;
        delete bareTx.id;
        delete bareTx.data;
        candidates.push(bareTx);
      }
      const trades = candidates.map(coerceCongressTrade).filter((t): t is CongressTrade => t !== null);
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
