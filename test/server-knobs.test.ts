/**
 * Server-level operational knobs (src/lib/server-knobs.ts) — the Infisical/env pause switches
 * made real runtime toggles:
 *   - resolution precedence: DB override > env > catalog default
 *   - short-TTL read cache with explicit invalidation on write
 *   - fail-open to env/default on any store READ error
 *   - SEC ingest worker park/resume driven by the SEC_INGEST_WORKER_ENABLED knob
 *   - admin route auth (requireAdmin) + `server_knob.changed` audit on every write
 *   - per-user source-settings precedence: user > server override > env (SEC_FILING_RAG_MAX_PER_RUN)
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const storeFault = vi.hoisted(() => ({ failReads: false }));

// Partial mock: reads can be forced to throw (fail-open coverage) while writes stay real.
vi.mock("../src/lib/db-settings", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/lib/db-settings")>();
  return {
    ...mod,
    getInternalSetting: (key: string) => {
      if (storeFault.failReads) throw new Error("settings store down");
      return mod.getInternalSetting(key);
    }
  };
});

import {
  SERVER_KNOBS_CATALOG,
  invalidateServerKnobCache,
  listEffectiveServerKnobs,
  resolveServerKnob,
  serverKnobBool,
  serverKnobOverride,
  setServerKnobOverride
} from "../src/lib/server-knobs";
import { getDb, setInternalSetting } from "../src/lib/db";
import { SERVER_KNOBS_SETTING_KEY } from "../src/lib/server-knobs";
import { patchUserSourceSettings, resolveSourceNumber } from "../src/lib/source-settings";
import { SecIngestWorker, secIngestWorkerEnabled, startSecIngestWorker } from "../src/lib/rag/sec-ingest-worker";
import { GET as knobsGet, POST as knobsPost } from "../app/api/admin/server-knobs/route";

const KNOB_ENV_IDS = SERVER_KNOBS_CATALOG.map((s) => s.id);

function clearKnobEnv(): void {
  for (const id of KNOB_ENV_IDS) delete process.env[id];
}

function clearAllOverrides(): void {
  setInternalSetting(SERVER_KNOBS_SETTING_KEY, {});
  invalidateServerKnobCache();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-server-knobs-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  storeFault.failReads = false;
  clearKnobEnv();
  clearAllOverrides();
});

afterEach(() => {
  storeFault.failReads = false;
  clearKnobEnv();
  vi.unstubAllEnvs();
});

describe("resolveServerKnob precedence", () => {
  it("resolves catalog default when neither override nor env is set", () => {
    expect(resolveServerKnob("SEC_INGEST_WORKER_ENABLED")).toBe(false);
    expect(resolveServerKnob("RAG_INGEST_BUDGET_ENABLED")).toBe(true);
    expect(resolveServerKnob("SEC_FILING_RAG_MAX_PER_RUN")).toBe(25);
  });

  it("env beats default; DB override beats env (booleans)", () => {
    process.env.SEC_INGEST_WORKER_ENABLED = "on";
    expect(resolveServerKnob("SEC_INGEST_WORKER_ENABLED")).toBe(true);
    setServerKnobOverride("SEC_INGEST_WORKER_ENABLED", false);
    expect(resolveServerKnob("SEC_INGEST_WORKER_ENABLED")).toBe(false);
    // Clearing the override falls back to env.
    setServerKnobOverride("SEC_INGEST_WORKER_ENABLED", null);
    expect(resolveServerKnob("SEC_INGEST_WORKER_ENABLED")).toBe(true);
  });

  it("env beats default; DB override beats env (numbers, clamped to catalog bounds)", () => {
    process.env.SEC_FILING_RAG_MAX_PER_RUN = "10";
    expect(resolveServerKnob("SEC_FILING_RAG_MAX_PER_RUN")).toBe(10);
    setServerKnobOverride("SEC_FILING_RAG_MAX_PER_RUN", 42);
    expect(resolveServerKnob("SEC_FILING_RAG_MAX_PER_RUN")).toBe(42);
    // 0 is a real value (documented ingest pause), not clamped away.
    setServerKnobOverride("SEC_FILING_RAG_MAX_PER_RUN", 0);
    expect(resolveServerKnob("SEC_FILING_RAG_MAX_PER_RUN")).toBe(0);
    // Out-of-bounds writes clamp to the catalog max.
    setServerKnobOverride("SEC_FILING_RAG_MAX_PER_RUN", 999_999);
    expect(resolveServerKnob("SEC_FILING_RAG_MAX_PER_RUN")).toBe(5000);
  });

  it("falsy env values disable a default-on knob; unrecognized env values keep the default", () => {
    process.env.R2_USAGE_DAILY_DIGEST = "off";
    expect(serverKnobBool("R2_USAGE_DAILY_DIGEST")).toBe(false);
    process.env.R2_USAGE_DAILY_DIGEST = "garbage";
    // Default-ON budget/digest knobs must not be silently disabled by an env typo.
    expect(serverKnobBool("R2_USAGE_DAILY_DIGEST")).toBe(true);
    process.env.RAG_PINECONE_WRITE_BUDGET_ENABLED = "0";
    expect(serverKnobBool("RAG_PINECONE_WRITE_BUDGET_ENABLED")).toBe(false);
  });

  it("throws on unknown knob ids (typo'd call site = programmer error)", () => {
    expect(() => resolveServerKnob("NOT_A_KNOB")).toThrow(/Unknown server knob/);
    expect(serverKnobOverride("NOT_A_KNOB")).toBeUndefined();
  });

  it("listEffectiveServerKnobs reports value + provenance + env reset target", () => {
    process.env.STREAMS_ALPACA_NEWS_ENABLED = "on";
    setServerKnobOverride("STREAMS_ALPACA_NEWS_ENABLED", false);
    const rows = listEffectiveServerKnobs();
    const news = rows.find((r) => r.spec.id === "STREAMS_ALPACA_NEWS_ENABLED")!;
    expect(news).toMatchObject({ value: false, source: "override", envValue: true, override: false });
    const congress = rows.find((r) => r.spec.id === "CONGRESS_STREAM_ENABLED")!;
    expect(congress).toMatchObject({ value: false, source: "default", envValue: false, override: null });
  });
});

describe("read cache TTL + invalidation on write", () => {
  it("a direct store write is invisible until invalidation, while setServerKnobOverride applies immediately", () => {
    expect(serverKnobBool("SEC_INGEST_WORKER_ENABLED")).toBe(false); // primes the cache
    // Bypass the setter (simulates another process / stale cache): cached read still wins.
    setInternalSetting(SERVER_KNOBS_SETTING_KEY, { SEC_INGEST_WORKER_ENABLED: true });
    expect(serverKnobBool("SEC_INGEST_WORKER_ENABLED")).toBe(false);
    invalidateServerKnobCache();
    expect(serverKnobBool("SEC_INGEST_WORKER_ENABLED")).toBe(true);

    // The real write path invalidates on its own — no TTL wait.
    setServerKnobOverride("SEC_INGEST_WORKER_ENABLED", false);
    expect(serverKnobBool("SEC_INGEST_WORKER_ENABLED")).toBe(false);
  });
});

describe("fail-open on store error", () => {
  it("a throwing store read resolves from env, then default — never throws", () => {
    setServerKnobOverride("RAG_INGEST_BUDGET_ENABLED", false);
    expect(serverKnobBool("RAG_INGEST_BUDGET_ENABLED")).toBe(false);

    storeFault.failReads = true;
    invalidateServerKnobCache();
    // Override is unreadable -> env tier.
    process.env.RAG_INGEST_BUDGET_ENABLED = "off";
    expect(serverKnobBool("RAG_INGEST_BUDGET_ENABLED")).toBe(false);
    delete process.env.RAG_INGEST_BUDGET_ENABLED;
    invalidateServerKnobCache();
    // No env either -> catalog default.
    expect(serverKnobBool("RAG_INGEST_BUDGET_ENABLED")).toBe(true);
  });
});

describe("SEC ingest worker park/resume", () => {
  it("parks while the knob resolves off and resumes within one interval of a flip on", async () => {
    const worker = new SecIngestWorker(20);
    const tick = vi.spyOn(worker, "runTick").mockResolvedValue(undefined);
    // The interval gate calls the module-level secIngestWorkerEnabled(); park/resume is observed
    // through whether ticks run. Knob starts off (no env, no override).
    expect(secIngestWorkerEnabled()).toBe(false);
    await worker.start();
    try {
      await sleep(120);
      expect(tick).not.toHaveBeenCalled(); // parked

      setServerKnobOverride("SEC_INGEST_WORKER_ENABLED", true);
      await vi.waitFor(() => expect(tick).toHaveBeenCalled(), { timeout: 2000 }); // resumed

      setServerKnobOverride("SEC_INGEST_WORKER_ENABLED", false);
      await sleep(60); // let any in-flight tick settle
      const settled = tick.mock.calls.length;
      await sleep(150);
      expect(tick.mock.calls.length).toBe(settled); // parked again
    } finally {
      await worker.stop();
    }
  });

  it("startSecIngestWorker starts the loop even while disabled (so a later flip on needs no reboot)", async () => {
    // The starter must not early-return on a disabled knob anymore — the loop parks instead.
    expect(secIngestWorkerEnabled()).toBe(false);
    startSecIngestWorker();
    const host = globalThis as typeof globalThis & { __secIngestWorkerInstance?: SecIngestWorker };
    expect(host.__secIngestWorkerInstance).toBeInstanceOf(SecIngestWorker);
    const { stopSecIngestWorker } = await import("../src/lib/rag/sec-ingest-worker");
    await stopSecIngestWorker();
  });
});

describe("admin server-knobs route", () => {
  function adminReq(method: "GET" | "POST", body?: unknown): Request {
    return new Request("https://trading.example.com/api/admin/server-knobs", {
      method,
      headers: { "x-admin-token": "test-ops-token", "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
  }

  beforeEach(() => {
    vi.stubEnv("ADMIN_REINDEX_TOKEN", "test-ops-token");
  });

  it("denies unauthenticated GET and POST with 403", async () => {
    const anon = new Request("https://trading.example.com/api/admin/server-knobs");
    expect((await knobsGet(anon)).status).toBe(403);
    const anonPost = new Request("https://trading.example.com/api/admin/server-knobs", {
      method: "POST",
      body: JSON.stringify({ id: "SEC_INGEST_WORKER_ENABLED", value: true })
    });
    expect((await knobsPost(anonPost)).status).toBe(403);
    // The denied write must not have landed.
    expect(resolveServerKnob("SEC_INGEST_WORKER_ENABLED")).toBe(false);
  });

  it("GET returns the catalog with effective values and provenance", async () => {
    process.env.STREAMS_ALPACA_NEWS_ENABLED = "on";
    const res = await knobsGet(adminReq("GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; knobs: Array<{ id: string; value: unknown; source: string; effect: string }> };
    expect(body.ok).toBe(true);
    expect(body.knobs.length).toBe(SERVER_KNOBS_CATALOG.length);
    const news = body.knobs.find((k) => k.id === "STREAMS_ALPACA_NEWS_ENABLED")!;
    expect(news).toMatchObject({ value: true, source: "env" });
    expect(news.effect.length).toBeGreaterThan(0);
  });

  it("POST writes an override, audits server_knob.changed with from/to, and clears via null", async () => {
    const res = await knobsPost(adminReq("POST", { id: "RAG_INGEST_BUDGET_ENABLED", value: false }));
    expect(res.status).toBe(200);
    expect(resolveServerKnob("RAG_INGEST_BUDGET_ENABLED")).toBe(false);

    const rows = getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'server_knob.changed' ORDER BY rowid DESC")
      .all() as Array<{ payload: string }>;
    expect(rows.length).toBeGreaterThan(0);
    const payload = JSON.parse(rows[0].payload) as { id: string; from: unknown; to: unknown };
    expect(payload).toMatchObject({ id: "RAG_INGEST_BUDGET_ENABLED", from: true, to: false });

    const clear = await knobsPost(adminReq("POST", { id: "RAG_INGEST_BUDGET_ENABLED", value: null }));
    expect(clear.status).toBe(200);
    expect(resolveServerKnob("RAG_INGEST_BUDGET_ENABLED")).toBe(true);
  });

  it("rejects unknown ids and type mismatches with 400 (no write, no audit)", async () => {
    expect((await knobsPost(adminReq("POST", { id: "NOT_A_KNOB", value: true }))).status).toBe(400);
    expect((await knobsPost(adminReq("POST", { id: "SEC_INGEST_WORKER_ENABLED", value: 7 }))).status).toBe(400);
    expect((await knobsPost(adminReq("POST", { id: "SEC_FILING_RAG_MAX_PER_RUN", value: "many" }))).status).toBe(400);
    expect(resolveServerKnob("SEC_INGEST_WORKER_ENABLED")).toBe(false);
    expect(resolveServerKnob("SEC_FILING_RAG_MAX_PER_RUN")).toBe(25);
  });
});

describe("source-settings integration (SEC_FILING_RAG_MAX_PER_RUN)", () => {
  afterEach(() => {
    patchUserSourceSettings("local", { SEC_FILING_RAG_MAX_PER_RUN: null });
  });

  it("precedence is user > server override > env > default", () => {
    process.env.SEC_FILING_RAG_MAX_PER_RUN = "10";
    expect(resolveSourceNumber("SEC_FILING_RAG_MAX_PER_RUN")).toBe(10);

    setServerKnobOverride("SEC_FILING_RAG_MAX_PER_RUN", 5);
    expect(resolveSourceNumber("SEC_FILING_RAG_MAX_PER_RUN")).toBe(5);

    patchUserSourceSettings("local", { SEC_FILING_RAG_MAX_PER_RUN: 42 });
    expect(resolveSourceNumber("SEC_FILING_RAG_MAX_PER_RUN")).toBe(42);

    patchUserSourceSettings("local", { SEC_FILING_RAG_MAX_PER_RUN: null });
    setServerKnobOverride("SEC_FILING_RAG_MAX_PER_RUN", 0); // server-level ingest pause survives resolution unclamped
    expect(resolveSourceNumber("SEC_FILING_RAG_MAX_PER_RUN")).toBe(0);
  });
});
