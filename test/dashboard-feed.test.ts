import { describe, expect, it } from "vitest";
import type { AuditEvent, StrategyDecision } from "../app/dashboard-types";
import { buildAuditFeed, buildSymbolMetaBySymbol, buildUnifiedFeed } from "../src/lib/dashboard-feed";
import { enrichPositionsForDisplay, formatNotificationDisplay, formatShareQuantity, ratingTitle, sentimentTitle } from "../src/lib/dashboard-ui";
import type { EquityPosition, MarketQuote, NotificationEvent } from "../src/lib/types";

describe("dashboard feed helpers", () => {
  it("keeps stored average cost for position display math", () => {
    const rows = enrichPositionsForDisplay(
      [{ symbol: "AAPL", quantity: 2, averageCost: 150, marketValue: 500 }],
      1000
    );

    expect(rows[0]?.averageCost).toBe(150);
    expect(rows[0]?.costBasis).toBe(300);
    expect(rows[0]?.pnl).toBe(200);
    expect(rows[0]?.allocPct).toBe(50);
  });

  it("builds symbol metadata from market scan company names and proposal symbols", () => {
    const latestStrategyRun: StrategyDecision = {
      runId: "run-1",
      status: "completed",
      summary: "ok",
      proposals: [{ proposal: proposal({ symbol: "PLTR", side: "buy" }), status: "paper", reasons: [] }],
      marketScan: {
        source: "test",
        generatedAt: "2026-06-15T00:00:00.000Z",
        scannedSymbols: 1,
        returnedQuotes: 1,
        topCandidates: [quote({ symbol: "PLTR", companyName: "Palantir Technologies Inc." })],
        sectorBySymbol: {},
        quotesBySymbol: {},
        warnings: []
      }
    };

    const meta = buildSymbolMetaBySymbol({
      positions: [{ symbol: "AAPL", quantity: 1, averageCost: 100, marketValue: 110 }],
      latestStrategyRun
    });

    expect(meta.PLTR?.companyName).toBe("Palantir Technologies Inc.");
    expect(meta.AAPL).toEqual({ companyName: undefined });
  });

  it("formats historical proposal approval audits into short buy/sell titles", () => {
    const audit: AuditEvent[] = [
      {
        id: "a1",
        createdAt: "2026-06-15T00:00:00.000Z",
        kind: "proposal_approved",
        payload: { proposalId: "p1", result: "paper" }
      }
    ];

    const feed = buildAuditFeed({
      audit,
      symbolMetaBySymbol: { PLTR: { companyName: "Palantir Technologies Inc." } },
      getProposalById: () => ({ proposal: proposal({ symbol: "PLTR", side: "buy" }) })
    });

    expect(feed[0]?.title).toBe("Buy PLTR Approved");
    expect(feed[0]?.detail).toContain("Test mode");
    expect(feed[0]?.companyName).toBe("Palantir Technologies Inc.");
  });

  it("formats notification audit rows into compact human-readable text", () => {
    const audit: AuditEvent[] = [
      {
        id: "a2",
        createdAt: "2026-06-15T00:01:00.000Z",
        kind: "notification",
        payload: {
          id: "n1",
          createdAt: "2026-06-15T00:01:00.000Z",
          type: "fill",
          title: "PLTR Paper approval fill",
          status: "skipped",
          payload: {
            fill: { symbol: "PLTR", side: "buy" }
          },
          error: "Notifications Webhook Not Configured"
        }
      }
    ];

    const feed = buildAuditFeed({ audit });

    expect(feed[0]?.title).toBe("Buy PLTR Skipped");
    expect(feed[0]?.detail).toContain("Notifications Webhook");
  });

  it("formats notification panel rows with action title and skipped-webhook detail", () => {
    const item = formatNotificationDisplay(
      {
        id: "n1",
        createdAt: "2026-06-15T02:52:17.000Z",
        type: "fill",
        title: "PLTR sell filled",
        status: "skipped",
        payload: {
          fill: { symbol: "PLTR", side: "sell", source: "live", status: "filled" }
        },
        error: "Notifications Webhook Not Configured"
      } satisfies NotificationEvent,
      { PLTR: { companyName: "Palantir Technologies Inc." } }
    );

    expect(item.title).toBe("Sold PLTR");
    expect(item.detail).toBe("Notification Skipped - Notifications Webhook Not Configured");
    expect(item.companyName).toBe("Palantir Technologies Inc.");
  });

  it("resolves nested proposal ids for blocked notification audits", () => {
    const audit: AuditEvent[] = [
      {
        id: "a3",
        createdAt: "2026-06-15T00:02:00.000Z",
        kind: "notification",
        payload: {
          id: "n2",
          createdAt: "2026-06-15T00:02:00.000Z",
          type: "block",
          title: "META blocked",
          status: "skipped",
          payload: { proposalId: "p2" },
          error: "Notifications Webhook Not Configured"
        }
      }
    ];

    const feed = buildAuditFeed({
      audit,
      getProposalById: () => ({ proposal: proposal({ symbol: "META", side: "buy" }) })
    });

    expect(feed[0]?.title).toBe("Buy META Blocked");
  });

  it("explains Yahoo mean scale in rating tooltips", () => {
    const title = ratingTitle(
      quote({
        symbol: "META",
        analystScore: 78,
        analystRating: "Buy",
        analystBySource: {
          "yahoo-finance": { score: 75, label: "Buy", mean: 2.1 }
        }
      })
    );

    expect(title).toContain("Yahoo mean 2.1; 1.0 = Strong Buy, 3.0 = Hold, 5.0 = Strong Sell");
  });

  it("states that sentiment is locally computed from headlines", () => {
    const title = sentimentTitle(
      quote({
        symbol: "META",
        sentiment: 68,
        headlines: ["Meta beats expectations on ad revenue"],
        sources: { sentiment: "finnhub" }
      })
    );

    expect(title).toContain("locally computed from recent Finnhub headlines using keyword scoring");
  });

  it("formats share quantities according to precision and symbol-specific rules", () => {
    expect(formatShareQuantity(1.55548)).toBe("1.56");
    expect(formatShareQuantity(0.00448933)).toBe("0.00449");
    expect(formatShareQuantity(0.5)).toBe("0.5");
    expect(formatShareQuantity(12)).toBe("12");
    expect(formatShareQuantity(123.456)).toBe("123");
    // >=3 integer digits: all whole-number digits preserved (no longer truncated to
    // 3 sig figs), comma-grouped for readability.
    expect(formatShareQuantity(1234.56)).toBe("1,235");
    expect(formatShareQuantity(12345.6)).toBe("12,346");
    expect(formatShareQuantity(12489.242)).toBe("12,489");

    expect(formatShareQuantity(1.55548, "NVDA")).toBe("1.56");
    expect(formatShareQuantity(0.00448933, "intc")).toBe("0.00449");
    expect(formatShareQuantity(0.5, "QCOM")).toBe("0.5");
    expect(formatShareQuantity(12, "NVDA")).toBe("12");
    expect(formatShareQuantity(123.456, "INTC")).toBe("123");
    expect(formatShareQuantity(1234.56, "QCOM")).toBe("1,235");
    expect(formatShareQuantity(12345.6, "NVDA")).toBe("12,346");
  });

  it("applies Test prefixing, custom notification tags, and grouping correctly in buildUnifiedFeed", () => {
    const feed = buildUnifiedFeed({
      audit: [
        {
          id: "a1",
          createdAt: "2026-06-15T00:00:00.000Z",
          kind: "policy_change",
          payload: { key: "maxOrderNotional" }
        },
        {
          id: "a2",
          createdAt: "2026-06-15T00:05:00.000Z",
          kind: "proposal_approved",
          payload: { proposalId: "p1", result: "paper" }
        }
      ],
      notifications: [
        {
          id: "n1",
          createdAt: "2026-06-15T00:04:00.000Z",
          type: "pending_approval",
          title: "Buy PLTR Proposal Pending",
          status: "skipped",
          payload: {
            proposalId: "p1",
            proposal: { symbol: "PLTR", side: "buy", type: "market" }
          },
          error: "Notifications Webhook Not Configured"
        }
      ],
      fills: [
        {
          id: "f1",
          proposalId: "p1",
          runId: "run-1",
          accountNumber: "A1",
          source: "paper",
          symbol: "PLTR",
          side: "buy",
          quantity: 10,
          price: 20,
          notional: 200,
          status: "filled",
          filledAt: "2026-06-15T00:06:00.000Z"
        }
      ],
      orders: [],
      symbolMetaBySymbol: { PLTR: { companyName: "Palantir Technologies Inc." } },
      getProposalById: () => ({ proposal: proposal({ symbol: "PLTR", side: "buy" }) })
    });

    const policyGroup = feed.find(g => g.tags.includes("policy change"));
    expect(policyGroup).toBeDefined();
    expect(policyGroup!.tags).toContain("notification disabled");
    expect(policyGroup!.tags).not.toContain("notification failed");

    const tradeGroup = feed.find(g => g.proposalId === "p1");
    expect(tradeGroup).toBeDefined();
    expect(tradeGroup!.title).toBe("Test BUY PLTR");
    expect(tradeGroup!.tags).toContain("notification failed");
    expect(tradeGroup!.tags).not.toContain("notification disabled");

    const pendingApprovalEvent = tradeGroup!.events.find(ev => ev.id === "n1");
    expect(pendingApprovalEvent).toBeDefined();
    expect(pendingApprovalEvent!.title).toBe("Test Buy PLTR Awaiting Approval");
  });

  it("shows an accepted broker order as pending until it fills or terminates", () => {
    const feed = buildUnifiedFeed({
      audit: [
        {
          id: "a1",
          createdAt: "2026-06-15T22:00:00.000Z",
          kind: "proposal_approved",
          payload: {
            proposalId: "p-vz",
            result: "placed",
            orderId: "alpaca-order-vz",
            brokerState: "accepted",
            fillStatus: "pending_reconciliation"
          }
        }
      ],
      notifications: [],
      fills: [
        {
          id: "f-vz",
          proposalId: "p-vz",
          runId: "run-vz",
          accountNumber: "APCA-PAPER",
          source: "paper",
          executionMode: "broker/paper",
          symbol: "VZ",
          side: "buy",
          quantity: 3,
          price: 41.25,
          notional: 123.75,
          status: "pending_reconciliation",
          brokerOrderId: "alpaca-order-vz",
          filledAt: "2026-06-15T22:00:01.000Z"
        }
      ],
      orders: [
        {
          id: "alpaca-order-vz",
          symbol: "VZ",
          side: "buy",
          type: "market",
          state: "accepted",
          quantity: 3,
          filledQuantity: 0,
          createdAt: "2026-06-15T22:00:00.000Z"
        }
      ],
      symbolMetaBySymbol: { VZ: { companyName: "Verizon Communications Inc." } },
      getProposalById: () => ({ proposal: proposal({ symbol: "VZ", side: "buy" }) })
    });

    const tradeGroup = feed.find(g => g.proposalId === "p-vz");
    expect(tradeGroup).toBeDefined();
    expect(tradeGroup!.status).toBe("pending_order");
    expect(tradeGroup!.detail).toContain("Accepted by broker; awaiting fill");
    expect(tradeGroup!.detail).toContain("Accepted");
  });

  it("shows terminal broker reconciliation as a broker outcome", () => {
    const feed = buildUnifiedFeed({
      audit: [],
      notifications: [],
      fills: [
        {
          id: "f-vz-rejected",
          proposalId: "p-vz",
          runId: "run-vz",
          accountNumber: "APCA-PAPER",
          source: "paper",
          executionMode: "broker/paper",
          symbol: "VZ",
          side: "buy",
          quantity: 3,
          price: 41.25,
          notional: 123.75,
          status: "rejected",
          brokerOrderId: "alpaca-order-vz",
          filledAt: "2026-06-16T13:35:00.000Z"
        }
      ],
      orders: [],
      symbolMetaBySymbol: { VZ: { companyName: "Verizon Communications Inc." } },
      getProposalById: () => ({ proposal: proposal({ symbol: "VZ", side: "buy" }) })
    });

    const tradeGroup = feed.find(g => g.proposalId === "p-vz");
    expect(tradeGroup).toBeDefined();
    expect(tradeGroup!.status).toBe("rejected");
    expect(tradeGroup!.detail).toContain("Broker reported Rejected");
    expect(tradeGroup!.detail).not.toContain("Rejected manually");
  });
});

function proposal(input: { symbol: string; side: "buy" | "sell" }) {
  return {
    symbol: input.symbol,
    side: input.side,
    type: "market" as const,
    timeInForce: "gfd" as const,
    marketHours: "regular_hours" as const,
    rationale: "test",
    tradeThesisTag: "test",
    entryMarketRegime: "test"
  };
}

function quote(input: Partial<MarketQuote> & { symbol: string }): MarketQuote {
  return {
    price: 100,
    volume: 1,
    intradayChangePct: 0,
    positionMarketValue: 0,
    score: 0,
    ...input
  };
}
