import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-qdrant-retrieval-${randomUUID()}.db`)}`;
});

import { retrieveContextDetailed, reconcileManagedVectorRecords } from "../src/lib/vector-db";
import { setServerKnobOverride, invalidateServerKnobCache } from "../src/lib/server-knobs";

describe("retrieveContextDetailed with Qdrant read backend", () => {
  beforeEach(() => {
    process.env.QDRANT_URL = "http://127.0.0.1:6333";
    process.env.QDRANT_API_KEY = "live-qdrant-key";
    process.env.SILICONFLOW_API_KEY = "live-sf-key";
    process.env.RAG_EMBED_PROVIDER = "siliconflow";
    invalidateServerKnobCache();
  });

  afterEach(() => {
    delete process.env.QDRANT_URL;
    delete process.env.QDRANT_API_KEY;
    delete process.env.SILICONFLOW_API_KEY;
    delete process.env.RAG_EMBED_PROVIDER;
    delete process.env.PINECONE_API_KEY;
    setServerKnobOverride("RAG_VECTOR_READ_QDRANT", null);
    invalidateServerKnobCache();
    vi.unstubAllGlobals();
  });

  it("retrieves context from Qdrant by default without Pinecone key or client", async () => {
    delete process.env.PINECONE_API_KEY;

    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("embeddings")) {
        return new Response(
          JSON.stringify({
            data: [{ embedding: new Array(1024).fill(0.01) }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (urlStr.includes("/points/search")) {
        return new Response(
          JSON.stringify({
            result: [
              {
                id: "d8c1c4b7-0000-0000-0000-000000000001",
                score: 0.88,
                payload: {
                  pc_id: "sec-filings:AAPL:10-k:2026:chunk-1",
                  symbol: "AAPL",
                  doc_type: "10-k",
                  scope: "shared",
                  tenant_scope: "shared:operator",
                  userId: "local",
                  text: "Apple Inc. reported quarterly revenue of 100B."
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    });

    vi.stubGlobal("fetch", mockFetch);

    const chunks = await retrieveContextDetailed("Apple revenue", "AAPL", 5, "local");
    expect(chunks).toBeDefined();
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text).toContain("Apple Inc. reported quarterly revenue");
    expect(chunks[0].id).toBe("sec-filings:AAPL:10-k:2026:chunk-1");
  });

  it("reconcileManagedVectorRecords returns empty reconcile result on Pinecone rate limits instead of throwing", async () => {
    delete process.env.PINECONE_API_KEY;
    const res = await reconcileManagedVectorRecords({ userId: "local", dryRun: true });
    expect(res).toBeDefined();
    expect(res.skipped).toBe(true);
    expect(res.promoted).toBe(0);
    expect(res.deleted).toBe(0);
  });
});
