/**
 * corpus-coverage-receipt (2026-07-06; corrected same day — see
 * docs/rollouts/2026-07-06-corpus-coverage-receipt.md): per-run advisory receipt for a
 * COVERAGE-CHECKED filings doc type (a static allowlist of types with a known producer in code —
 * COVERAGE_CHECKED_DOC_TYPES in strategy.ts, currently 10-k/10-q/8-k) that produced ZERO retrieved
 * chunks this run.
 *
 * Ground truth: strategy.ts's filings-RAG pass (retrieveContextDetailed(..., { docType: ["10-k",
 * "10-q", "8-k", "earnings-transcript"] })) is the only doc-type-requesting call site.
 *
 * BLOCKER fixed here: the receipt originally used `ingestedAccessionCountForDocType` (reading
 * `ingested_accessions`) as a "has this doc type ever been produced" proxy. But the default-ON 8-K
 * SUMMARY writer (src/lib/web-sources/sec8k.ts, `refreshEightK`'s `storeContexts` call) writes
 * retrievable `doc_type: "8-k"` chunks to the vector corpus WITHOUT ever calling
 * `insertIngestedAccession` — only the default-OFF full-body writer (`ingestEightKBody`) does, and
 * it stores the row under the "8-K-body" sentinel besides. So in the default config,
 * `ingested_accessions` has ZERO "8-k" rows even though 8-K chunks exist and are retrievable,
 * meaning the receipt would false-positive on "8-k" every day an 8-K chunk simply didn't rank
 * top-3. There is no local table that ALL chunk writers populate keyed by doc_type
 * (`document_chunks` has no `doc_type` column at all — confirmed against db.ts's schema), so the
 * fix drops the ingested-rows check entirely and gates the receipt on
 * COVERAGE_CHECKED_DOC_TYPES, a static allowlist of doc types known (by reading the writers) to
 * have a producer in code. "earnings-transcript" is excluded from that allowlist (Finding 2: it
 * has no producer anywhere, so checking it would fire a receipt every run forever).
 *
 * Covers:
 *  (a) computeEmptyDocTypes (pure): flags only the coverage-checked type(s) that produced no
 *      chunks this run; case-insensitive.
 *  (b) full strategy run: receipt fires (one audit + one evidence item) naming only the
 *      empty coverage-checked type when 2 of 3 coverage-checked types retrieve nothing.
 *  (c) REGRESSION for the BLOCKER: an 8-K SUMMARY chunk is retrieved this run (proving the corpus
 *      has real 8-K chunks) but NO `insertIngestedAccession("...", "8-K"/"8-K-body", ...)` call
 *      ever happened (mirrors the default config exactly) — the receipt must NOT fire for "8-k".
 *  (d) "earnings-transcript" never produces a receipt even when it retrieves nothing (it is not
 *      in COVERAGE_CHECKED_DOC_TYPES).
 *  (e) advisory invariant: ragContext / proposal count is unchanged by the receipt firing.
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
  it("flags only the coverage-checked type(s) that produced no chunks this run", () => {
    const empty = computeEmptyDocTypes(["10-k", "10-q", "8-k"], ["10-k", "8-k"]);
    expect(empty).toEqual(["10-q"]);
  });

  it("flags nothing when every coverage-checked type was retrieved this run", () => {
    const empty = computeEmptyDocTypes(["10-k", "8-k"], ["10-k", "8-k"]);
    expect(empty).toEqual([]);
  });

  it("flags all coverage-checked types when none retrieved this run", () => {
    const empty = computeEmptyDocTypes(["10-k", "10-q", "8-k"], []);
    expect(empty).toEqual(["10-k", "10-q", "8-k"]);
  });

  it("is case-insensitive on both retrieved doc_type and the coverage-checked type", () => {
    const empty = computeEmptyDocTypes(["10-K"], ["10-k"]);
    expect(empty).toEqual([]);
  });

  it("never considers earnings-transcript (not passed in by the caller's allowlist)", () => {
    // strategy.ts only ever passes COVERAGE_CHECKED_DOC_TYPES (10-k/10-q/8-k) here —
    // "earnings-transcript" simply never appears as an input, so it can never be flagged.
    const empty = computeEmptyDocTypes(["10-k", "10-q", "8-k"], ["10-k", "10-q", "8-k"]);
    expect(empty).toEqual([]);
  });
});

describe("ingestedAccessionCountForDocType / ingestedAccessionCountsByDocType (db-learning, generic diagnostic helpers — NOT used by the coverage receipt anymore)", () => {
  it("reports 0 for a doc type with no ingested rows", async () => {
    const { ingestedAccessionCountForDocType } = await import("../src/lib/db");
    expect(ingestedAccessionCountForDocType("earnings-transcript")).toBe(0);
  });

  it("reports non-zero for a doc type with ingested rows, tolerating the ingested_accessions naming split — but 0 for '8-k' when only the summary path (no insertIngestedAccession) ran", async () => {
    const { insertIngestedAccession, ingestedAccessionCountForDocType } = await import("../src/lib/db");
    // Mirrors src/lib/web-sources/sec-filings.ts (10-K/10-Q stored as the raw SEC form letter).
    insertIngestedAccession(`acc-${randomUUID()}`, "10-K", "AAPL", 4);
    // Mirrors src/lib/web-sources/sec8k.ts's FULL-BODY writer (stores "8-K-body", not "8-K").
    insertIngestedAccession(`acc-${randomUUID()}`, "8-K-body", "AAPL", 2);

    expect(ingestedAccessionCountForDocType("10-k")).toBeGreaterThan(0);
    // The full-body row above DOES count toward "8-k" via prefix-matching — this function is
    // correct for that writer. Its documented caveat is that the default-ON SUMMARY writer never
    // calls insertIngestedAccession at all, so this count understates true corpus coverage for
    // "8-k" in the default config — which is exactly why the coverage receipt no longer uses it.
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
  it("(b) fires ONE audit + ONE evidence item naming only the coverage-checked type that retrieved nothing", async () => {
    // This run's filings pass retrieves "10-k" and "8-k" chunks; "10-q" retrieves nothing.
    // "earnings-transcript" also retrieves nothing but must never be reported (not coverage-checked).
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

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    const { listAudit, listSocraticDecisionCases } = await import("../src/lib/db");
    const runAudits = listAudit(500).filter((e) => (e.payload as { runId?: string })?.runId === result.runId);
    const coverageAudits = runAudits.filter((e) => e.kind === "rag_doc_type_coverage_empty");
    expect(coverageAudits.length).toBe(1);

    const payload = coverageAudits[0]!.payload as { emptyDocTypes?: string[]; requestedDocTypes?: string[] };
    expect(payload.emptyDocTypes).toEqual(["10-q"]);
    expect(payload.requestedDocTypes).toEqual(["10-k", "10-q", "8-k", "earnings-transcript"]);

    const cases = listSocraticDecisionCases("local", { runId: result.runId });
    expect(cases.length).toBeGreaterThanOrEqual(1);
    const coverageItems = cases[0]!.evidence.filter(
      (item) => item.kind === "safety" && item.title === "Requested filings doc type never ingested"
    );
    expect(coverageItems.length).toBe(1);
    expect(coverageItems[0]!.summary).toContain("10-q");
    expect(coverageItems[0]!.summary).not.toContain("earnings-transcript");
    expect(coverageItems[0]!.tone).toBe("warning");
  }, 30_000);

  it("(c) REGRESSION (BLOCKER fix): does NOT false-positive on '8-k' when an 8-K SUMMARY chunk is retrieved this run WITHOUT any ingested_accessions row ever recorded for it", async () => {
    // Mirrors the default production config exactly: the 8-K summary writer (sec8k.ts,
    // WEB_SOURCE_SEC8K default ON) stores retrievable "8-k" chunks but never calls
    // insertIngestedAccession (only the default-OFF full-body writer does). No
    // insertIngestedAccession call happens anywhere in this test — proving the receipt no longer
    // depends on that table at all. All three coverage-checked types retrieve chunks this run.
    vi.doMock("../src/lib/vector-db", () => ({
      findRelevantExperiences: async () => [],
      upsertExperiences: async () => {},
      retrieveContext: async () => [],
      retrieveContextDetailed: async () => [
        { id: "chunk-10k", text: "Risk factors.", score: 0.5, doc_type: "10-k", source: "sec-filings", as_of: "2026-01-01" },
        { id: "chunk-10q", text: "Quarterly.", score: 0.5, doc_type: "10-q", source: "sec-filings", as_of: "2026-01-01" },
        // The load-bearing chunk for this regression test: an 8-K SUMMARY chunk (doc_type "8-k",
        // source "sec-8k" — exactly as refreshEightK's storeContexts call tags it), with NO
        // corresponding ingested_accessions row inserted anywhere in this test.
        { id: "chunk-8k-summary", text: "SEC 8-K filing for AAPL. Material event.", score: 0.5, doc_type: "8-k", source: "sec-8k", as_of: "2026-01-01" }
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

    // Deliberately NOT calling insertIngestedAccession for "8-K"/"8-K-body" anywhere — this is
    // the exact scenario that made the old ingested_accessions-based check false-positive daily.
    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    const { listAudit } = await import("../src/lib/db");
    const runAudits = listAudit(500).filter((e) => (e.payload as { runId?: string })?.runId === result.runId);
    const coverageAudits = runAudits.filter((e) => e.kind === "rag_doc_type_coverage_empty");
    // All three coverage-checked types (10-k/10-q/8-k) retrieved chunks this run, so the receipt
    // must not fire at all — "8-k" in particular must NOT be reported despite zero
    // ingested_accessions rows for it.
    expect(coverageAudits.length).toBe(0);
  }, 30_000);

  it("(d) does NOT fire for earnings-transcript even though it retrieves nothing every run (no producer, excluded from coverage checking)", async () => {
    // All three coverage-checked types retrieve chunks; earnings-transcript (not coverage-checked)
    // retrieves nothing, as it always will until a producer exists.
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

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const result = await runStrategyOnce();
    expect(result.status).toBe("completed");

    const { listAudit } = await import("../src/lib/db");
    const runAudits = listAudit(500).filter((e) => (e.payload as { runId?: string })?.runId === result.runId);
    expect(runAudits.filter((e) => e.kind === "rag_doc_type_coverage_empty").length).toBe(0);
  }, 30_000);

  it("(e) advisory invariant: the receipt firing does not change ragContext content or proposal count", async () => {
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
