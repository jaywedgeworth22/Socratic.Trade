import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// Cooldown regression for bearUnavailable() (strategy.ts): this alert previously fired on EVERY
// failed strategy run with NO cooldown at all -- a real 2026-07-02 outage produced 16 alerts across
// ~15 hours, roughly one per hourly run. It now shares db-health.ts's internal-settings cooldown
// pattern (getInternalSetting/setInternalSetting, 6h window, a single global key). This verifies:
// the outbound alert (sendNotification + notify) fires on the first failed run, is suppressed on an
// immediate second failed run (same cooldown window), while the per-run audit trail
// (strategy_bear_review_unavailable) -- which other code/tests key off per-run -- still fires EVERY
// time regardless of the cooldown.

vi.mock("../src/lib/vector-db", () => ({
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  retrieveContextDetailed: async () => [],
  defaultMinScore: () => 0.3,
  defaultRelevanceFloor: () => 0.3,
  defaultDedupeSimilarity: () => 0.6,
  formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
  storeContext: async () => {},
  storeContexts: async () => {}
}));
// Use the canned local test gateway (no HTTP) even for an "alpaca" paper account, so the run reaches
// broker/paper mode without needing real Alpaca credentials or network.
vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  const { getTestGateway } = await import("../src/lib/robinhood");
  return { ...actual, getBrokerGateway: (_policy: unknown, userId: string = "local") => getTestGateway(userId) };
});

// vi.mock(...) calls are hoisted above ordinary top-level `const`s, so the spies they close over
// must themselves be declared via vi.hoisted() -- otherwise the factory closes over a
// not-yet-initialized binding and the mock silently doesn't wire up (the real notify/sendNotification
// run instead, and the spies below never see a call).
const { notifySpy, sendNotificationSpy } = vi.hoisted(() => ({
  notifySpy: vi.fn(async (...args: unknown[]) => [] as unknown[]),
  sendNotificationSpy: vi.fn(async (...args: unknown[]) => ({}) as unknown)
}));

vi.mock("../src/lib/notify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/notify")>();
  return { ...actual, notify: (...args: unknown[]) => notifySpy(...args) };
});

vi.mock("../src/lib/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/notifications")>();
  return { ...actual, sendNotification: (...args: unknown[]) => sendNotificationSpy(...args) };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-bear-cooldown-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  notifySpy.mockClear();
  sendNotificationSpy.mockClear();
});

beforeEach(async () => {
  const { getDb } = await import("../src/lib/db");
  getDb().exec("DELETE FROM trade_proposals;");
});

const BULL_PROPOSAL = {
  symbol: "AAPL",
  side: "buy",
  type: "market",
  dollarAmount: 1000,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "Bull thesis for AAPL",
  tradeThesisTag: "Breakout",
  confidenceScore: 60
};

function nasdaqResponse(): Response {
  return new Response(
    JSON.stringify({
      data: {
        asof: "2026-06-15",
        table: {
          rows: [
            {
              symbol: "AAPL",
              lastsale: "$200",
              pctchange: "1%",
              volume: "1000000",
              marketCap: "3000000000000",
              sector: "Technology",
              industry: "Consumer Electronics"
            }
          ]
        }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function bullOk(): Response {
  return new Response(JSON.stringify({ output_text: JSON.stringify({ proposals: [BULL_PROPOSAL] }) }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

// The Bear call always returns HTTP 429 -- every run's inline Bear review fails, every run.
function stubFetchBearAlwaysFails(): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("api.openai.com")) {
      const body = String(init?.body ?? "");
      const isBear = body.includes("Bear Agent") || body.includes("bear_proposals");
      if (isBear) return new Response("rate limited", { status: 429 });
      return bullOk();
    }
    if (href.includes("nasdaq.com")) return nasdaqResponse();
    return new Response("not found", { status: 404 });
  });
}

async function setupBrokerPaperDecide(label: string): Promise<void> {
  const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
  upsertUserApiKey("local", "openai", "test-openai-key", "test fixture");
  const accountId = randomUUID();
  upsertConnectedAccount({
    id: accountId,
    userId: "local",
    broker: "alpaca",
    environment: "paper",
    accountNumber: "TEST",
    label,
    apiKey: "PK-TEST",
    apiSecret: "sk-test",
    isActive: true
  });
  setActiveConnectedAccount(accountId);
  setPolicy({
    ...DEFAULT_POLICY,
    systemState: "active",
    activeBroker: "alpaca",
    accountNumber: "TEST",
    llmModel: "gpt-4.1-mini",
    includedIndices: [],
    additionalSymbols: ["AAPL"],
    strategyAuthority: "decide",
    maxOrderPctOfNav: 100,
    maxDailyNotional: 400_000,
    maxDailyPctOfNav: 0,
    maxSymbolExposurePct: 100,
    maxGrossExposurePct: 1000,
    maxNetExposurePct: 1000
  });
}

describe("bearUnavailable() alert cooldown (strategy.ts)", () => {
  it(
    "alerts on the first failed run, suppresses the alert on an immediate second failed run, but audits every run",
    async () => {
      vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
      stubFetchBearAlwaysFails();
      await setupBrokerPaperDecide("Bear cooldown");
      const { runStrategyOnce } = await import("../src/lib/strategy");
      const { listAudit } = await import("../src/lib/db");

      const firstRun = await runStrategyOnce();
      const firstRunAuditKinds = listAudit(500)
        .filter((e) => (e.payload as { runId?: string })?.runId === firstRun.runId)
        .map((e) => e.kind);
      expect(firstRunAuditKinds).toContain("strategy_bear_review_unavailable");

      // notify(userId, message, opts) carries the title on arg[1]; sendNotification(input, opts)
      // carries it on arg[0] -- check both shapes so this works for either spy.
      const bearTitleCalls = (spy: typeof notifySpy | typeof sendNotificationSpy) =>
        spy.mock.calls.filter((call) =>
          call.some((arg) => typeof (arg as { title?: string } | undefined)?.title === "string" && (arg as { title: string }).title.includes("Red Team (inline Bear) review unavailable")
          )
        );

      // First failed run: the alert goes out on both channels used by bearUnavailable.
      expect(bearTitleCalls(notifySpy).length).toBeGreaterThan(0);
      expect(bearTitleCalls(sendNotificationSpy).length).toBeGreaterThan(0);

      notifySpy.mockClear();
      sendNotificationSpy.mockClear();

      // Second run, immediately after (well inside the 6h cooldown window): Bear fails again,
      // proposals are again routed to human review (the audit trail still fires per-run)...
      const { getDb } = await import("../src/lib/db");
      getDb().exec("DELETE FROM trade_proposals;");
      const secondRun = await runStrategyOnce();
      const secondRunAuditKinds = listAudit(500)
        .filter((e) => (e.payload as { runId?: string })?.runId === secondRun.runId)
        .map((e) => e.kind);
      expect(secondRunAuditKinds).toContain("strategy_bear_review_unavailable");

      // ...but the OUTBOUND alert (sendNotification/notify) is suppressed by the cooldown --
      // this is the fix: previously every failed run re-alerted with no cooldown at all.
      expect(bearTitleCalls(notifySpy).length).toBe(0);
      expect(bearTitleCalls(sendNotificationSpy).length).toBe(0);
    },
    30_000
  );
});
