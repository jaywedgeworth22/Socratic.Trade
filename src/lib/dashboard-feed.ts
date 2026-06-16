import type { EquityOrder, EquityPosition, FillEvent, NotificationEvent, PendingProposal, TradeProposal } from "./types";
import { formatQuantity } from "./money";

export interface SymbolMeta {
  companyName?: string;
}

export interface AuditFeedItem {
  id: string;
  createdAt: string;
  title: string;
  detail: string;
  symbol?: string;
  companyName?: string;
}

interface SourceAuditEvent {
  id: string;
  createdAt: string;
  kind: string;
  payload: unknown;
}

export interface StrategyDecisionLike {
  runId: string;
  status: "completed" | "failed";
  summary: string;
  proposals: Array<{ proposal: TradeProposal; status: string; reasons: string[]; orderId?: string }>;
  marketScan?: {
    topCandidates: Array<{ symbol: string; companyName?: string }>;
    quotesBySymbol?: Record<string, { symbol: string; companyName?: string }>;
  };
}

export function buildSymbolMetaBySymbol(input: {
  positions?: EquityPosition[];
  livePositions?: EquityPosition[];
  paperPositions?: EquityPosition[];
  orders?: EquityOrder[];
  pendingProposals?: PendingProposal[];
  latestStrategyRun?: StrategyDecisionLike;
}): Record<string, SymbolMeta> {
  const meta: Record<string, SymbolMeta> = {};

  const ensure = (symbol?: string, companyName?: string) => {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) return;
    meta[normalized] = {
      companyName: companyName?.trim() || meta[normalized]?.companyName
    };
  };

  for (const position of input.positions ?? []) ensure(position.symbol);
  for (const position of input.livePositions ?? []) ensure(position.symbol);
  for (const position of input.paperPositions ?? []) ensure(position.symbol);
  for (const order of input.orders ?? []) ensure(order.symbol);
  for (const pending of input.pendingProposals ?? []) ensure(pending.proposal.symbol);

  const decision = input.latestStrategyRun;
  for (const proposal of decision?.proposals ?? []) ensure(proposal.proposal.symbol);
  for (const quote of decision?.marketScan?.topCandidates ?? []) ensure(quote.symbol, quote.companyName);
  for (const quote of Object.values(decision?.marketScan?.quotesBySymbol ?? {})) ensure(quote.symbol, quote.companyName);

  return meta;
}

export function buildAuditFeed(input: {
  audit: SourceAuditEvent[];
  symbolMetaBySymbol?: Record<string, SymbolMeta>;
  getProposalById?: (proposalId: string) => { proposal: TradeProposal } | undefined;
}): AuditFeedItem[] {
  const symbolMetaBySymbol = input.symbolMetaBySymbol ?? {};

  return input.audit.map((event) => {
    const payload = asRecord(event.payload);
    const proposalLookup = proposalFromPayload(payload, input.getProposalById);
    const symbol = normalizeSymbol(
      stringValue(payload.symbol) ??
        stringValue(proposalLookup?.proposal?.symbol) ??
        notificationSymbol(payload)
    );
    const side = normalizeSide(stringValue(payload.side) ?? stringValue(proposalLookup?.proposal?.side) ?? notificationSide(payload));
    const companyName = symbol ? symbolMetaBySymbol[symbol]?.companyName : undefined;

    const feed = formatAuditEvent(event.kind, payload, { symbol, side, companyName });
    return {
      id: event.id,
      createdAt: event.createdAt,
      title: feed.title,
      detail: feed.detail,
      symbol,
      companyName
    };
  });
}

function formatAuditEvent(
  kind: string,
  payload: Record<string, unknown>,
  context: { symbol?: string; side?: "buy" | "sell"; companyName?: string }
): { title: string; detail: string } {
  if (kind === "strategy_run") {
    return {
      title: payload.status === "failed" ? "Strategy run failed" : "Strategy run completed",
      detail: shortText(stringValue(payload.summary) ?? "No summary")
    };
  }

  if (kind === "policy_change") {
    return {
      title: "Policy updated",
      detail: `Changed ${stringValue(payload.key) ?? "settings"}`
    };
  }

  if (kind === "profile_change") {
    const action = stringValue(payload.action) ?? "updated";
    return {
      title: `Profile ${action}`,
      detail: shortText(stringValue(payload.name) ?? "Strategy profile")
    };
  }

  if (kind === "proposal_approved") {
    const result = stringValue(payload.result) ?? "approved";
    const titlePrefix = sideLabel(context.side, context.symbol) ?? "Proposal";
    const title =
      result === "blocked"
        ? `${titlePrefix} Blocked`
        : result === "placed" || result === "paper"
          ? `${titlePrefix} Approved`
          : `${titlePrefix} ${capitalize(result)}`;
    const detail =
      joinDetail([
        result === "paper" ? "Paper mode" : undefined,
        result === "placed" ? "Order placed" : undefined,
        stringValue(payload.orderId) ? `Order ${stringValue(payload.orderId)}` : undefined,
        firstReason(payload)
      ]) ?? "Awaiting next update";
    return { title, detail };
  }

  if (kind === "proposal_rejected") {
    return {
      title: `${sideLabel(context.side, context.symbol) ?? "Proposal"} Rejected`,
      detail: "Rejected manually"
    };
  }

  if (kind === "notification") {
    const notification = payload as unknown as NotificationEvent;
    const symbol = normalizeSymbol(notificationSymbol(payload)) ?? context.symbol;
    const side = normalizeSide(notificationSide(payload)) ?? context.side;
    const statusVerb = notification.status === "sent" ? "sent" : notification.status === "failed" ? "failed" : "skipped";
    if (notification.type === "fill") {
      return {
        title: `${sideLabel(side, symbol) ?? symbol ?? "Trade"} ${capitalize(statusVerb)}`,
        detail: notification.error ? shortText(notification.error) : shortText(notification.title)
      };
    }
    if (notification.type === "pending_approval") {
      return {
        title: `${sideLabel(side, symbol) ?? symbol ?? "Proposal"} Approval Pending`,
        detail: notification.error ? shortText(notification.error) : shortText(notification.title)
      };
    }
    if (notification.type === "block") {
      return {
        title: `${sideLabel(side, symbol) ?? symbol ?? "Proposal"} Blocked`,
        detail: notification.error ? shortText(notification.error) : shortText(firstReason(asRecord(notification.payload)) ?? notification.title)
      };
    }
    return {
      title: `${humanizeNotificationType(notification.type)} ${capitalize(statusVerb)}`,
      detail: notification.error ? shortText(notification.error) : shortText(notification.title)
    };
  }

  if (kind === "fill_reconciled") {
    return {
      title: `${context.symbol ?? "Fill"} reconciled`,
      detail: joinDetail([
        stringValue(payload.status),
        numberValue(payload.quantity) ? `Qty ${trimNumber(numberValue(payload.quantity) ?? 0)}` : undefined,
        numberValue(payload.price) ? `@ ${trimCurrency(numberValue(payload.price) ?? 0)}` : undefined
      ]) ?? "Broker state synced"
    };
  }

  if (kind === "order_cancel") {
    return {
      title: "Order cancel requested",
      detail: shortText(stringValue(payload.orderId) ? `Order ${stringValue(payload.orderId)}` : "Broker request submitted")
    };
  }

  return {
    title: humanizeKind(kind),
    detail: shortText(JSON.stringify(payload))
  };
}

function proposalFromPayload(
  payload: Record<string, unknown>,
  getProposalById?: (proposalId: string) => { proposal: TradeProposal } | undefined
) {
  const nested = asRecord(payload.payload);
  const proposalId = stringValue(payload.proposalId) ?? stringValue(nested.proposalId);
  return proposalId && getProposalById ? getProposalById(proposalId) : undefined;
}

function firstReason(payload: Record<string, unknown>): string | undefined {
  const reason = stringValue(payload.reason);
  if (reason) return reason;
  const reasons = payload.reasons;
  if (Array.isArray(reasons)) {
    const first = reasons.find((item) => typeof item === "string");
    if (typeof first === "string") return first;
  }
  return undefined;
}

function notificationSymbol(payload: Record<string, unknown>): string | undefined {
  const nested = asRecord(payload.payload);
  const fill = asRecord(nested.fill);
  const proposal = asRecord(nested.proposal);
  return stringValue(fill.symbol) ?? stringValue(proposal.symbol) ?? symbolFromTitle(stringValue(payload.title));
}

function notificationSide(payload: Record<string, unknown>): string | undefined {
  const nested = asRecord(payload.payload);
  const fill = asRecord(nested.fill);
  const proposal = asRecord(nested.proposal);
  return stringValue(fill.side) ?? stringValue(proposal.side);
}

function symbolFromTitle(title?: string): string | undefined {
  if (!title) return undefined;
  const match = title.match(/\b[A-Z][A-Z0-9.-]{0,9}\b/);
  return match?.[0];
}

function normalizeSymbol(symbol?: string): string | undefined {
  const value = symbol?.trim().toUpperCase();
  return value ? value : undefined;
}

function normalizeSide(side?: string): "buy" | "sell" | undefined {
  return side === "buy" || side === "sell" ? side : undefined;
}

function sideLabel(side?: "buy" | "sell", symbol?: string): string | undefined {
  if (!symbol) return undefined;
  if (!side) return symbol;
  return `${side === "buy" ? "Buy" : "Sell"} ${symbol}`;
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value;
}

function shortText(value: string): string {
  return value.length > 90 ? `${value.slice(0, 87)}...` : value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function humanizeNotificationType(type?: string): string {
  if (!type) return "Notification";
  return type.replace(/_/g, " ");
}

function humanizeKind(kind: string): string {
  return kind.replace(/_/g, " ");
}

function trimNumber(value: number): string {
  const decimals = Math.abs(value) >= 1 ? 3 : 4;
  return value.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

function trimCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function joinDetail(parts: Array<string | undefined>): string | undefined {
  const filtered = parts.filter(Boolean);
  return filtered.length > 0 ? filtered.join(" · ") : undefined;
}

import { formatNotificationDisplay } from "./dashboard-ui";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export interface UnifiedActivitySubEvent {
  id: string;
  createdAt: string;
  type: "audit" | "notification" | "fill" | "order";
  title: string;
  detail: string;
  status?: string;
  error?: string;
  raw?: unknown;
}

export interface UnifiedActivityGroup {
  id: string;
  proposalId?: string;
  createdAt: string;
  updatedAt: string;
  symbol?: string;
  side?: "buy" | "sell";
  companyName?: string;
  title: string;
  detail: string;
  status: string;
  tags: string[];
  events: UnifiedActivitySubEvent[];
}

export function buildUnifiedFeed(input: {
  audit: SourceAuditEvent[];
  notifications: NotificationEvent[];
  fills: FillEvent[];
  orders: EquityOrder[];
  symbolMetaBySymbol: Record<string, SymbolMeta>;
  getProposalById?: (proposalId: string) => { proposal: TradeProposal } | undefined;
}): UnifiedActivityGroup[] {
  const symbolMetaBySymbol = input.symbolMetaBySymbol ?? {};
  const proposalIdByOrderId: Record<string, string> = {};

  // Build mapping of order_id to proposal_id from fills
  for (const fill of input.fills) {
    if (fill.proposalId && fill.brokerOrderId) {
      proposalIdByOrderId[fill.brokerOrderId] = fill.proposalId;
    }
  }

  // Build mapping from audit events
  for (const event of input.audit) {
    if (event.kind === "proposal_approved") {
      const payload = asRecord(event.payload);
      const proposalId = stringValue(payload.proposalId);
      const orderId = stringValue(payload.orderId);
      if (proposalId && orderId) {
        proposalIdByOrderId[orderId] = proposalId;
      }
    }
  }

  const groupEvents: Record<string, UnifiedActivitySubEvent[]> = {};

  const addSubEvent = (groupId: string, subEvent: UnifiedActivitySubEvent) => {
    if (!groupEvents[groupId]) groupEvents[groupId] = [];
    groupEvents[groupId].push(subEvent);
  };

  const proposalIdByGroupId = new Map<string, string>();
  const symbolByGroupId = new Map<string, string>();
  const sideByGroupId = new Map<string, "buy" | "sell" | undefined>();

  // Helper to extract symbol and side from a proposal lookup
  const lookupProposalInfo = (proposalId: string) => {
    if (input.getProposalById) {
      const lookup = input.getProposalById(proposalId);
      if (lookup?.proposal) {
        return {
          symbol: normalizeSymbol(lookup.proposal.symbol),
          side: normalizeSide(lookup.proposal.side)
        };
      }
    }
    return {};
  };

  // 1. Process Audit Events
  for (const event of input.audit) {
    if (event.kind === "notification") {
      continue;
    }

    const payload = asRecord(event.payload);
    const proposalId = getProposalIdFromAudit(event);

    let symbol = normalizeSymbol(stringValue(payload.symbol));
    let side = normalizeSide(stringValue(payload.side));

    if (proposalId) {
      const pInfo = lookupProposalInfo(proposalId);
      if (pInfo.symbol) symbol = pInfo.symbol;
      if (pInfo.side) side = pInfo.side;
    }

    const companyName = symbol ? symbolMetaBySymbol[symbol]?.companyName : undefined;
    const feed = formatAuditEvent(event.kind, payload, { symbol, side, companyName });

    const subEvent: UnifiedActivitySubEvent = {
      id: event.id,
      createdAt: event.createdAt,
      type: "audit",
      title: feed.title,
      detail: feed.detail,
      raw: { kind: event.kind, payload: event.payload }
    };

    const groupId = proposalId ? `prop-${proposalId}` : `audit-${event.id}`;
    if (proposalId) {
      proposalIdByGroupId.set(groupId, proposalId);
    }
    if (symbol) symbolByGroupId.set(groupId, symbol);
    if (side) sideByGroupId.set(groupId, side);

    addSubEvent(groupId, subEvent);
  }

  // 2. Process Notification Events
  for (const event of input.notifications) {
    const payload = asRecord(event.payload);
    const proposalId = getProposalIdFromNotification(event);

    const display = formatNotificationDisplay(event, symbolMetaBySymbol);

    let symbol = normalizeSymbol(display.symbol);
    let side = normalizeSide(stringValue(asRecord(payload.fill).side) ?? stringValue(asRecord(payload.proposal).side));

    if (proposalId) {
      const pInfo = lookupProposalInfo(proposalId);
      if (pInfo.symbol) symbol = pInfo.symbol;
      if (pInfo.side) side = pInfo.side;
    }

    const subEvent: UnifiedActivitySubEvent = {
      id: event.id,
      createdAt: event.createdAt,
      type: "notification",
      title: display.title,
      detail: display.detail,
      status: event.status,
      error: event.error,
      raw: event.payload
    };

    const groupId = proposalId ? `prop-${proposalId}` : `notif-${event.id}`;
    if (proposalId) {
      proposalIdByGroupId.set(groupId, proposalId);
    }
    if (symbol) symbolByGroupId.set(groupId, symbol);
    if (side) sideByGroupId.set(groupId, side);

    addSubEvent(groupId, subEvent);
  }

  // 3. Process Fill Events
  for (const fill of input.fills) {
    const proposalId = fill.proposalId ?? undefined;
    const symbol = normalizeSymbol(fill.symbol);
    const side = normalizeSide(fill.side);

    const formattedQty = formatQuantity(fill.quantity, symbol);
    const subEvent: UnifiedActivitySubEvent = {
      id: fill.id,
      createdAt: fill.filledAt,
      type: "fill",
      title: `${fill.source === "paper" ? "Paper " : ""}${fill.side.toUpperCase()} ${fill.symbol}`,
      detail: `${formattedQty} shares @ ${trimCurrency(fill.price)} · ${fill.status}`,
      status: fill.status,
      raw: fill.raw
    };

    const groupId = proposalId ? `prop-${proposalId}` : `fill-${fill.id}`;
    if (proposalId) {
      proposalIdByGroupId.set(groupId, proposalId);
    }
    if (symbol) symbolByGroupId.set(groupId, symbol);
    if (side) sideByGroupId.set(groupId, side);

    addSubEvent(groupId, subEvent);
  }

  // 4. Process Broker Orders
  for (const order of input.orders) {
    const proposalId = proposalIdByOrderId[order.id];
    const symbol = normalizeSymbol(order.symbol);
    const side = normalizeSide(order.side);

    const formattedFilled = formatQuantity(order.filledQuantity, symbol);
    const formattedTotal = formatQuantity(order.quantity, symbol);
    const subEvent: UnifiedActivitySubEvent = {
      id: order.id,
      createdAt: order.createdAt,
      type: "order",
      title: `Order Placed: ${order.side.toUpperCase()} ${order.symbol}`,
      detail: `State: ${order.state} · Qty ${formattedFilled} / ${formattedTotal} · ${order.type}`,
      status: order.state,
      raw: order
    };

    const groupId = proposalId ? `prop-${proposalId}` : `order-${order.id}`;
    if (proposalId) {
      proposalIdByGroupId.set(groupId, proposalId);
    }
    if (symbol) symbolByGroupId.set(groupId, symbol);
    if (side) sideByGroupId.set(groupId, side);

    addSubEvent(groupId, subEvent);
  }

  const unifiedGroups: UnifiedActivityGroup[] = [];

  for (const [groupId, events] of Object.entries(groupEvents)) {
    events.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const earliestDate = events[0]!.createdAt;
    const latestDate = events[events.length - 1]!.createdAt;

    const proposalId = proposalIdByGroupId.get(groupId);
    const symbol = symbolByGroupId.get(groupId);
    const side = sideByGroupId.get(groupId);
    const companyName = symbol ? symbolMetaBySymbol[symbol]?.companyName : undefined;

    const tagsSet = new Set<string>();
    for (const ev of events) {
      if (ev.type === "audit") {
        const rawAud = asRecord(ev.raw);
        const audKind = stringValue(rawAud.kind) ?? "";
        if (audKind === "policy_change" || audKind === "profile_change") {
          tagsSet.add("policy change");
        }
        if (audKind === "fill_reconciled") {
          tagsSet.add("trade");
        }
      }
      if (ev.type === "fill") {
        tagsSet.add("trade");
      }
      if (ev.type === "notification") {
        const nStatus = ev.status;
        if (nStatus === "sent") {
          tagsSet.add("notification sent");
        } else if (nStatus === "failed") {
          tagsSet.add("notification failed");
        } else if (nStatus === "skipped") {
          tagsSet.add("notification disabled");
        }
        const nRaw = asRecord(ev.raw);
        if (stringValue(nRaw.type) === "fill") {
          tagsSet.add("trade");
        }
      }
    }

    if (side === "buy") { tagsSet.add("buy"); tagsSet.add("trade"); }
    if (side === "sell") { tagsSet.add("sell"); tagsSet.add("trade"); }

    let status = "unknown";
    let title = "";
    let detail = "";

    if (proposalId) {
      const hasFill = events.find(ev => ev.type === "fill");
      const hasApproval = events.find(ev => ev.type === "audit" && ev.title.includes("Approved"));
      const hasRejection = events.find(ev => ev.type === "audit" && ev.title.includes("Rejected"));
      const hasBlock = events.find(ev => ev.type === "notification" && ev.title.includes("Blocked"));
      const hasPendingApproval = events.find(ev => ev.type === "notification" && ev.title.includes("Approval Pending"));

      if (hasFill) {
        status = hasFill.status === "filled" ? "filled" : "pending_reconciliation";
      } else if (hasRejection) {
        status = "rejected";
      } else if (hasApproval) {
        status = "approved";
      } else if (hasBlock) {
        status = "blocked";
      } else if (hasPendingApproval) {
        status = "pending_approval";
      } else {
        status = "pending";
      }

      const isPaper = events.some(ev => ev.title.startsWith("Paper ") || ev.title.includes("Paper") || (ev.type === "fill" && ev.title.startsWith("Paper")));

      if (isPaper) {
        for (const ev of events) {
          const matchesAction = ev.title.match(/^(buy|sell|bought|sold|buy:|sell:)/i);
          if (matchesAction && !ev.title.startsWith("Paper ")) {
            ev.title = `Paper ${ev.title}`;
          }
        }
      }

      // Group title mirrors the broker-style fill/order title casing (uppercase side),
      // distinct from the title-case used by individual notification/audit sub-events.
      const displaySide = side === "buy" ? "BUY" : side === "sell" ? "SELL" : "Trade";
      title = `${isPaper ? "Paper " : ""}${displaySide} ${symbol}`;

      if (status === "filled") {
        const fillEv = events.find(ev => ev.type === "fill" && ev.status === "filled")!;
        detail = fillEv.detail;
      } else if (status === "pending_reconciliation") {
        const fillEv = events.find(ev => ev.type === "fill")!;
        detail = `Pending Reconciliation: ${fillEv.detail}`;
      } else if (status === "rejected") {
        detail = "Rejected manually";
      } else if (status === "approved") {
        const appEv = events.find(ev => ev.type === "audit" && ev.title.includes("Approved"))!;
        detail = appEv.detail;
      } else if (status === "blocked") {
        const blkEv = events.find(ev => ev.type === "notification" && ev.title.includes("Blocked"))!;
        detail = blkEv.detail;
      } else if (status === "pending_approval") {
        detail = "Awaiting Approval";
      } else {
        detail = events[0]!.detail;
      }
    } else {
      title = events[0]!.title;
      detail = events[0]!.detail;
      status = events[0]!.status ?? "completed";
    }
    const tagsList = Array.from(tagsSet);
    const isPolicyUpdate = tagsList.includes("policy change") || title.includes("Policy updated") || title.includes("Profile");

    if (isPolicyUpdate) {
      if (!tagsList.includes("notification disabled")) {
        tagsList.push("notification disabled");
      }
      const failedIdx = tagsList.indexOf("notification failed");
      if (failedIdx !== -1) tagsList.splice(failedIdx, 1);
    } else {
      if (!tagsList.includes("notification failed")) {
        tagsList.push("notification failed");
      }
      const disabledIdx = tagsList.indexOf("notification disabled");
      if (disabledIdx !== -1) tagsList.splice(disabledIdx, 1);
    }
    unifiedGroups.push({
      id: groupId,
      proposalId,
      createdAt: earliestDate,
      updatedAt: latestDate,
      symbol,
      side,
      companyName,
      title,
      detail,
      status,
      tags: tagsList,
      events
    });
  }

  return unifiedGroups.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function getProposalIdFromAudit(event: SourceAuditEvent): string | undefined {
  const payload = asRecord(event.payload);
  const nested = asRecord(payload.payload);
  return (
    stringValue(payload.proposalId) ??
    stringValue(nested.proposalId)
  );
}

function getProposalIdFromNotification(event: NotificationEvent): string | undefined {
  const payload = asRecord(event.payload);
  const fill = asRecord(payload.fill);
  const proposal = asRecord(payload.proposal);
  return (
    stringValue(payload.proposalId) ??
    stringValue(fill.proposalId) ??
    stringValue(proposal.id) ??
    stringValue(proposal.proposalId)
  );
}

