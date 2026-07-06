/**
 * corpus-coverage-receipt (2026-07-06): per-run advisory receipt for a requested filings doc type
 * that produced ZERO retrieved chunks this run AND has ZERO ever-ingested rows in the corpus.
 *
 * Ground truth: strategy.ts's filings-RAG pass (retrieveContextDetailed(..., { docType: ["10-k",
 * "10-q", "8-k", "earnings-transcript"] })) is the only doc-type-requesting call site;
 * "earnings-transcript" has no writer anywhere in this repo today, so it is a genuine
 * zero-producer doc type. The receipt must fire for that case, but must NOT fire for a doc type
 * that merely didn't rank this run despite having ingested rows (normal low-relevance, would
 * false-positive daily otherwise).
 *
 * Covers:
 *  (a) ingestedAccessionCountForDocType reports 0 for an un-ingested type, non-zero for an
 *      ingested one (including the ingested_accessions doc_type naming split, e.g. "8-K-body").
 *  (b) computeEmptyDocTypes / the full strategy run: receipt fires (one audit +
 *      one evidence item) naming only the empty-and-never-ingested type(s) when a run requests 4
 *      types, retrieves 2, and the missing ones have zero ingested rows.
 *  (c) NO false-positive receipt when a missing-this-run type HAS ingested rows.
 *  (d) advisory invariant: ragContext / proposal count is unchanged by the receipt firing.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { computeEmptyDocTypes } from "../src/lib/prompt-safety";

// Canned local test gateway (no HTTP) for the "alpaca" paper account, as in the other strategy tests.
vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  const { getTestGateway } = await import("../src/lib/robinhood");
  return { ...actual, getBrokerGateway: (_policy: unknown, userId: string = "local") => getTestGateway(userId) };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-rag-doc-type-coverage-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("computeEmptyDocTypes (pure)", () => {
  it("flags only the requested type that was neither retrieved this run nor ever ingested", () => {
    const empty = computeEmptyDocTypes(
      ["10-k", "10-q", "8-k", "earnings-transcript"],
      ["10-k", "8-k"],
      { "10-k": 5, "10-q": 3, "8-k": 2, "earnings-transcript": 0 }
    );
    expect(empty).toEqual(["earnings-transcript"]);
  });

  it("does NOT flag a type that is missing this run but HAS ingested rows (normal low-relevance)", () => {
    const empty = computeEmptyDocTypes(
      ["10-k", "10-q", "8-k", "earnings-transcript"],
      ["10-k", "8-k"],
      { "10-k": 5, "10-q": 3, "8-k": 2, "earnings-transcript": 0 }
    );
    // "10-q" was not retrieved but HAS 3 ingested rows -> must not appear.
    expect(empty).not.toContain("10-q");
    // "earnings-transcript" was not retrieved and has 0 ingested rows -> must appear.
    expect(empty).toContain("earnings-transcript");
  });

  it("flags nothing when every requested type was retrieved this run", () => {
    const empty = computeEmptyDocTypes(["10-k", "8-k"], ["10-k", "8-k"], { "10-k": 0, "8-k": 0 });
    expect(empty).toEqual([]);
  });

  it("flags nothing when every missing type has ingested rows", () => {
    const empty = computeEmptyDocTypes(["10-k", "10-q"], ["10-k"], { "10-k": 5, "10-q": 1 });
    expect(empty).toEqual([]);
  });

  it("is case-insensitive on both retrieved doc_type and requested doc type", () => {
    const empty = computeEmptyDocTypes(["10-K"], ["10-k"], { "10-k": 0 });
    expect(empty).toEqual([]);
  });
});

describe("ingestedAccessionCountForDocType / ingestedAccessionCountsByDocType (db-learning)", () => {
  it("reports 0 for a doc type with no ingested rows", async () => {
    const { ingestedAccessionCountForDocType } = await import("../src/lib/db");
    expect(ingestedAccessionCountForDocType("earnings-transcript")).toBe(0);
  });

  it("reports non-zero for a doc type with ingested rows, tolerating the ingested_accessions naming split", async () => {
    const { insertIngestedAccession, ingestedAccessionCountForDocType } = await import("../src/lib/db");
    // Mirrors src/lib/web-sources/sec-filings.ts (10-K/10-Q stored as the raw SEC form letter).
    insertIngestedAccession(`acc-${randomUUID()}`, "10-K", "AAPL", 4);
    // Mirrors src/lib/web-sources/sec8k.ts (8-K bodies stored under the "8-K-body" sentinel, NOT "8-K").
    insertIngestedAccession(`acc-${randomUUID()}`, "8-K-body", "AAPL", 2);

    expect(ingestedAccessionCountForDocType("10-k")).toBeGreaterThan(0);
    expect(ingestedAccessionCountForDocType("8-k")).toBeGreaterThan(0);
    expect(ingestedAccessionCountForDocType("earnings-transcript")).toBe(0);
  });
});

// ── Strategy-level integration: receipt fires / does not fire, advisory invariant ──────────────

type OpenAiBody = { input?: Array<{ role: string; content: string }> };

const BULL_PROPOSAL = {
  symbol: "AAPL",
  side: "buy",
  type: "market",
  dollarAmount: 1000,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "Structured momentum evidence for AAPL",
  tradeThesisTag: "Momentum-Breakout",
  confidenceScore: 40
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

function stubFetch(openAiBodies: OpenAiBody[]): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("api.openai.com")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as OpenAiBody;
      openAiBodies.push(body);
      return new Response(JSON.stringify({ output_text: JSON.stringify({ proposals: [BULL_PROPOSAL] }) }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (href.includes("nasdaq.com")) return nasdaqResponse();
    return new Response("not found", { status: 404 });
  });
}

async function setupBrokerPaperDecide(): Promise<void> {
  const { setPolicy, upsertConnectedAccount, setActiveConnectedAccount, upsertUserApiKey } = await import("../src/lib/db");
  upsertUserApiKey("local", "openai", "test-openai-key", "test fixture");
  const accountId = randomUUID();
  upsertConnectedAccount({
    id: accountId,
    userId: "local",
    broker: "alpaca",
    environment: "paper",
    accountNumber: "TEST",
    label: "Doc-Type Coverage Test",
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

describe("corpus-coverage receipt — strategy.ts integration (advisory only)", () => {
  it("(b) fires ONE audit + ONE evidence item naming only the empty-and-never-ingested type(s) when 2 of 4 requested types retrieve nothing and have zero ingested rows", async () => {
    // This run's filings pass retrieves "10-k" and "8-k" chunks; "10-q" and "earnings-transcript"
    // retrieve nothing. Before the run, seed an ingested row for "10-q" only (so it must NOT be
    // reported) — "earnings-transcript" stays genuinely zero-producer.
    vi.doMock("../src/lib/vector-db", () => ({
      findRelevantExperiences: async () => [],
      upsertExperiences: async () => {},
      retrieveContext: async () => [],
      retrieveContextDetailed: async () => [
        { id: "chunk-10k", text: "Risk factors.", score: 0.5, doc_type: "10-k", source: "sec-filings", as_of: "2026-01-01" },
        { id: "chunk-8k", text: "Material event.", score: 0.5, doc_type: "8-k", source: "sec-8k", as_of: "2026-01-01" }
      ],
      defaultMinScore: () => 0.3,
      defaultRelevanceFloor: () => 0.3,
      defaultDedupeSimilarity: () => 0.6,
      formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
      storeContext: async () => {},
      storeContexts: async () => ({ attempted: 0, indexed: 0 })
    }));

    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    const openAiBodies: OpenAiBody[] = [];
    stubFetch(openAiBodies);
    await setupBrokerPaperDecide();

    const { insertIngestedAccession } = await import("../src/lib/db");
    insertIngestedAccession(`acc-${randomUUID()}`, "10-Q", "AAPL", 3);

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    const { listAudit, listSocraticDecisionCases } = await import("../src/lib/db");
    const runAudits = listAudit(500).filter((e) => (e.payload as { runId?: string })?.runId === result.runId);
    const coverageAudits = runAudits.filter((e) => e.kind === "rag_doc_type_coverage_empty");
    expect(coverageAudits.length).toBe(1);

    const payload = coverageAudits[0]!.payload as { emptyDocTypes?: string[]; requestedDocTypes?: string[] };
    expect(payload.emptyDocTypes).toEqual(["earnings-transcript"]);
    expect(payload.requestedDocTypes).toEqual(["10-k", "10-q", "8-k", "earnings-transcript"]);

    const cases = listSocraticDecisionCases("local", { runId: result.runId });
    expect(cases.length).toBeGreaterThanOrEqual(1);
    const coverageItems = cases[0]!.evidence.filter(
      (item) => item.kind === "safety" && item.title === "Requested filings doc type never ingested"
    );
    expect(coverageItems.length).toBe(1);
    expect(coverageItems[0]!.summary).toContain("earnings-transcript");
    expect(coverageItems[0]!.summary).not.toContain("10-q,");
    expect(coverageItems[0]!.tone).toBe("warning");
  }, 30_000);

  it("(c) does NOT fire when the only missing-this-run type has ingested rows (no false positive)", async () => {
    // Retrieve all doc types EXCEPT "earnings-transcript" — but seed ingested rows for it too, so
    // even that one must not be reported (both conditions must hold for a receipt).
    vi.doMock("../src/lib/vector-db", () => ({
      findRelevantExperiences: async () => [],
      upsertExperiences: async () => {},
      retrieveContext: async () => [],
      retrieveContextDetailed: async () => [
        { id: "chunk-10k", text: "Risk factors.", score: 0.5, doc_type: "10-k", source: "sec-filings", as_of: "2026-01-01" },
        { id: "chunk-10q", text: "Quarterly.", score: 0.5, doc_type: "10-q", source: "sec-filings", as_of: "2026-01-01" },
        { id: "chunk-8k", text: "Material event.", score: 0.5, doc_type: "8-k", source: "sec-8k", as_of: "2026-01-01" }
      ],
      defaultMinScore: () => 0.3,
      defaultRelevanceFloor: () => 0.3,
      defaultDedupeSimilarity: () => 0.6,
      formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
      storeContext: async () => {},
      storeContexts: async () => ({ attempted: 0, indexed: 0 })
    }));

    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    const openAiBodies: OpenAiBody[] = [];
    stubFetch(openAiBodies);
    await setupBrokerPaperDecide();

    const { insertIngestedAccession } = await import("../src/lib/db");
    insertIngestedAccession(`acc-${randomUUID()}`, "earnings-transcript", "AAPL", 1);

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    const { listAudit } = await import("../src/lib/db");
    const runAudits = listAudit(500).filter((e) => (e.payload as { runId?: string })?.runId === result.runId);
    expect(runAudits.filter((e) => e.kind === "rag_doc_type_coverage_empty").length).toBe(0);
  }, 30_000);

  it("(d) advisory invariant: the receipt firing does not change ragContext content or proposal count", async () => {
    vi.doMock("../src/lib/vector-db", () => ({
      findRelevantExperiences: async () => [],
      upsertExperiences: async () => {},
      retrieveContext: async () => [],
      retrieveContextDetailed: async () => [
        { id: "chunk-10k", text: "Risk factors for AAPL.", score: 0.5, doc_type: "10-k", source: "sec-filings", as_of: "2026-01-01" }
      ],
      defaultMinScore: () => 0.3,
      defaultRelevanceFloor: () => 0.3,
      defaultDedupeSimilarity: () => 0.6,
      formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
      storeContext: async () => {},
      storeContexts: async () => ({ attempted: 0, indexed: 0 })
    }));

    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    const openAiBodies: OpenAiBody[] = [];
    stubFetch(openAiBodies);
    await setupBrokerPaperDecide();

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");
    // Proposal flow unaffected: the stubbed LLM's single proposal still survives to completion.
    expect(result.proposals.length).toBeGreaterThanOrEqual(1);

    const systemOf = (b: OpenAiBody) => b.input?.find((i) => i.role === "system")?.content ?? "";
    const userOf = (b: OpenAiBody) => b.input?.find((i) => i.role === "user")?.content ?? "";
    const bullBody = openAiBodies.find((b) => systemOf(b).includes("autonomous equity trading agent"));
    expect(bullBody).toBeDefined();
    const bullUser = JSON.parse(userOf(bullBody!)) as Record<string, unknown>;
    // ragContext (retrievedFinancialContext) carries ONLY the retrieved chunk text — the coverage
    // receipt must never be injected into it.
    const ragField = String(bullUser.retrievedFinancialContext ?? "");
    expect(ragField).toContain("Risk factors for AAPL.");
    expect(ragField).not.toContain("never ingested");
    expect(ragField).not.toContain("earnings-transcript");
  }, 30_000);
});
