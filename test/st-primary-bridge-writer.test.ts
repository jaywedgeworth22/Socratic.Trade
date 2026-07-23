import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = `file:${join(tmpdir(), `st-primary-writer-${randomUUID()}.db`)}`;
process.env.ENCRYPTION_KEY = "0".repeat(64);

const db = await import("../src/lib/db");
const writer = await import("../src/lib/st-primary-bridge-writer");

const PROJECT_ID = "39d93bb7-76f9-498c-8b50-a7def52e072f";
const SECRET_PATH = "/usage-monitor/st-primary/v1";
const MANIFEST = "BRIDGE_MANIFEST_V1";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function manifest(
  sequence: number,
  gemini: { status: "active"; value: string } | { status: "revoked" },
  deepseek: { status: "active"; value: string } | { status: "revoked" }
): string {
  return JSON.stringify({
    schemaVersion: 1,
    source: "socratic-trade-primary",
    complete: true,
    sequence,
    entries: [
      {
        id: "gemini.apiKey",
        providerName: "google-ai",
        capability: "apiKey",
        secretName: "GEMINI_API_KEY",
        status: gemini.status,
        fingerprint: gemini.status === "active" ? sha256(gemini.value) : null,
      },
      {
        id: "deepseek.apiKey",
        providerName: "deepseek",
        capability: "apiKey",
        secretName: "DEEPSEEK_API_KEY",
        status: deepseek.status,
        fingerprint: deepseek.status === "active" ? sha256(deepseek.value) : null,
      },
    ],
  });
}

interface CapturedCall {
  method: string;
  name?: string;
  body?: Record<string, unknown>;
}

interface FakeInfisicalOptions {
  initial?: Record<string, string>;
  failWriteName?: string;
  unexpectedName?: string;
  beforeManifestRead?: (
    readNumber: number,
    store: Map<string, string>
  ) => void | Promise<void>;
  afterWrite?: (name: string, store: Map<string, string>) => void;
}

function fakeInfisical(options: FakeInfisicalOptions = {}) {
  const store = new Map(Object.entries(options.initial ?? {}));
  if (options.unexpectedName) store.set(options.unexpectedName, "foreign");
  const calls: CapturedCall[] = [];
  let manifestReads = 0;

  const secretRecord = (name: string, value: string, includePath: boolean) => ({
    id: `id-${name}`,
    _id: `id-${name}`,
    workspace: PROJECT_ID,
    environment: "prod",
    version: 1,
    type: "shared",
    secretKey: name,
    secretValue: value,
    ...(includePath ? { secretPath: SECRET_PATH } : {}),
  });

  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/api/v1/auth/universal-auth/login") {
      calls.push({ method, name: "login" });
      return Response.json({ accessToken: "short-lived-test-token" });
    }
    if (url.pathname === "/api/v4/secrets") {
      calls.push({ method, name: "list" });
      return Response.json({
        secrets: [...store.keys()].map((name) => secretRecord(name, "", false)),
      });
    }
    const prefix = "/api/v4/secrets/";
    if (!url.pathname.startsWith(prefix)) return new Response("not found", { status: 404 });
    const name = decodeURIComponent(url.pathname.slice(prefix.length));
    if (method === "GET") {
      if (name === MANIFEST) {
        manifestReads += 1;
        await options.beforeManifestRead?.(manifestReads, store);
      }
      calls.push({ method, name });
      const value = store.get(name);
      if (value === undefined) return new Response(null, { status: 404 });
      return Response.json({ secret: secretRecord(name, value, true) });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, name, body });
    if (name === options.failWriteName) {
      return new Response("write failed", { status: 500 });
    }
    const value = body.secretValue;
    if (typeof value !== "string") return new Response("bad", { status: 422 });
    store.set(name, value);
    options.afterWrite?.(name, store);
    return Response.json({ secret: secretRecord(name, value, false) });
  }) as typeof fetch;

  return { fetcher, calls, store };
}

function syncOptions(fetcher: typeof fetch) {
  return {
    enabled: true,
    clientId: "writer-id",
    clientSecret: "writer-secret",
    baseUrl: "https://infisical.test",
    fetcher,
  } as const;
}

function writes(calls: CapturedCall[]): CapturedCall[] {
  return calls.filter(({ method }) => method === "POST" || method === "PATCH").slice(1);
}

beforeEach(() => {
  writer.__resetStPrimaryBridgeWriterForTests();
  db.getDb().exec(
    "DELETE FROM user_api_keys; " +
    "DELETE FROM settings WHERE key LIKE 'st-primary-bridge-writer:%';"
  );
  delete process.env.INFISICAL_ST_PRIMARY_WRITER_ENABLED;
  delete process.env.INFISICAL_ST_PRIMARY_WRITER_CLIENT_ID;
  delete process.env.INFISICAL_ST_PRIMARY_WRITER_CLIENT_SECRET;
});

afterEach(() => {
  writer.__resetStPrimaryBridgeWriterForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Socratic primary-account bridge writer", () => {
  it("is default-off and performs no database credential read or network call", async () => {
    const remote = fakeInfisical();
    await expect(writer.syncStPrimaryBridgeWriter({ fetcher: remote.fetcher })).resolves.toEqual({
      status: "disabled",
    });
    expect(remote.calls).toEqual([]);
  });

  it("fails closed for missing or partial dedicated writer identities", async () => {
    const remote = fakeInfisical();
    await expect(writer.syncStPrimaryBridgeWriter({ enabled: true, fetcher: remote.fetcher }))
      .resolves.toEqual({ status: "unconfigured" });
    await expect(writer.syncStPrimaryBridgeWriter({
      enabled: true,
      clientId: "writer-id",
      fetcher: remote.fetcher,
    })).resolves.toEqual({ status: "error", errorCode: "incomplete_writer_identity" });
    expect(remote.calls).toEqual([]);
  });

  it("keeps the request timeout active while a response body is stalled", async () => {
    vi.useFakeTimers();
    const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => {
            controller.error(new Error("aborted"));
          }, { once: true });
        },
      }));
    }) as typeof fetch;

    const result = writer.syncStPrimaryBridgeWriter(syncOptions(fetcher));
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(result).resolves.toEqual({
      status: "error",
      errorCode: "response_read_failed",
    });
  });

  it("disables redirect following on credential-bearing requests", async () => {
    const redirects: Array<RequestRedirect | undefined> = [];
    const fetcher = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      redirects.push(init?.redirect);
      return new Response(null, {
        status: 307,
        headers: { location: "https://untrusted.invalid/capture" },
      });
    }) as typeof fetch;

    await expect(writer.syncStPrimaryBridgeWriter(syncOptions(fetcher))).resolves.toEqual({
      status: "error",
      errorCode: "auth_http_307",
    });
    expect(redirects).toEqual(["error"]);
  });

  it("publishes both active local credentials before a strict sequence-1 manifest", async () => {
    db.upsertUserApiKey(db.LOCAL_USER, "gemini", "gemini-current");
    db.upsertUserApiKey(db.LOCAL_USER, "deepseek", "deepseek-current");
    const remote = fakeInfisical();

    await expect(writer.syncStPrimaryBridgeWriter(syncOptions(remote.fetcher))).resolves.toEqual({
      status: "synced",
      sequence: 1,
      active: 2,
      revoked: 0,
    });

    expect(writes(remote.calls).map(({ name }) => name)).toEqual([
      "GEMINI_API_KEY",
      "DEEPSEEK_API_KEY",
      MANIFEST,
    ]);
    expect(remote.store.get("GEMINI_API_KEY")).toBe("gemini-current");
    expect(remote.store.get("DEEPSEEK_API_KEY")).toBe("deepseek-current");
    const published = JSON.parse(remote.store.get(MANIFEST)!);
    expect(published).toEqual(JSON.parse(manifest(
      1,
      { status: "active", value: "gemini-current" },
      { status: "active", value: "deepseek-current" }
    )));
    expect(JSON.stringify(published)).not.toContain("gemini-current");
    expect(JSON.stringify(published)).not.toContain("deepseek-current");
  });

  it("uses a keyless manifest tombstone and never requests delete permission", async () => {
    db.upsertUserApiKey(db.LOCAL_USER, "gemini", "gemini-current");
    const remote = fakeInfisical({ initial: { DEEPSEEK_API_KEY: "stale-deepseek" } });

    await expect(writer.syncStPrimaryBridgeWriter(syncOptions(remote.fetcher))).resolves.toMatchObject({
      status: "synced",
      active: 1,
      revoked: 1,
    });
    expect(remote.calls.some(({ method }) => method === "DELETE")).toBe(false);
    expect(remote.store.get("DEEPSEEK_API_KEY")).toBe("stale-deepseek");
    const published = JSON.parse(remote.store.get(MANIFEST)!);
    expect(published.entries[1]).toEqual({
      id: "deepseek.apiKey",
      providerName: "deepseek",
      capability: "apiKey",
      secretName: "DEEPSEEK_API_KEY",
      status: "revoked",
      fingerprint: null,
    });
  });

  it("is idempotent when the complete remote generation and values match", async () => {
    db.upsertUserApiKey(db.LOCAL_USER, "gemini", "gemini-current");
    db.upsertUserApiKey(db.LOCAL_USER, "deepseek", "deepseek-current");
    const remote = fakeInfisical({
      initial: {
        GEMINI_API_KEY: "gemini-current",
        DEEPSEEK_API_KEY: "deepseek-current",
        [MANIFEST]: manifest(
          5,
          { status: "active", value: "gemini-current" },
          { status: "active", value: "deepseek-current" }
        ),
      },
    });

    await expect(writer.syncStPrimaryBridgeWriter(syncOptions(remote.fetcher))).resolves.toEqual({
      status: "unchanged",
      sequence: 5,
      active: 2,
      revoked: 0,
    });
    expect(writes(remote.calls)).toEqual([]);
    expect(db.getInternalSetting(writer.ST_PRIMARY_BRIDGE_WRITER_STATE_KEY)).toMatchObject({
      schemaVersion: 1,
      sequence: 5,
    });
  });

  it("rotates one value, verifies it, and commits the incremented manifest last", async () => {
    db.upsertUserApiKey(db.LOCAL_USER, "gemini", "gemini-new");
    db.upsertUserApiKey(db.LOCAL_USER, "deepseek", "deepseek-current");
    const remote = fakeInfisical({
      initial: {
        GEMINI_API_KEY: "gemini-old",
        DEEPSEEK_API_KEY: "deepseek-current",
        [MANIFEST]: manifest(
          5,
          { status: "active", value: "gemini-old" },
          { status: "active", value: "deepseek-current" }
        ),
      },
    });

    await expect(writer.syncStPrimaryBridgeWriter(syncOptions(remote.fetcher))).resolves.toMatchObject({
      status: "synced",
      sequence: 6,
    });
    expect(writes(remote.calls).map(({ method, name }) => ({ method, name }))).toEqual([
      { method: "PATCH", name: "GEMINI_API_KEY" },
      { method: "PATCH", name: MANIFEST },
    ]);
    expect(JSON.parse(remote.store.get(MANIFEST)!).sequence).toBe(6);
  });

  it("does not convert an undecryptable local row into a remote revocation", async () => {
    const now = new Date().toISOString();
    db.getDb().prepare(
      `INSERT INTO user_api_keys (id, user_id, service, api_key, label, created_at, updated_at)
       VALUES ('broken', 'local', 'gemini', '00:00:00', NULL, ?, ?)`
    ).run(now, now);
    const remote = fakeInfisical();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(writer.syncStPrimaryBridgeWriter(syncOptions(remote.fetcher))).resolves.toEqual({
      status: "error",
      errorCode: "local_key_unreadable",
    });
    expect(remote.calls).toEqual([]);
  });

  it("rejects malformed manifests and unexpected names without overwriting the path", async () => {
    db.upsertUserApiKey(db.LOCAL_USER, "gemini", "gemini-current");
    const duplicate = manifest(
      2,
      { status: "active", value: "gemini-current" },
      { status: "revoked" }
    ).replace('"sequence":2', '"sequence":2,"sequence":3');
    const malformed = fakeInfisical({ initial: { [MANIFEST]: duplicate } });
    await expect(writer.syncStPrimaryBridgeWriter(syncOptions(malformed.fetcher))).resolves.toEqual({
      status: "error",
      errorCode: "manifest_duplicate_member",
    });
    expect(writes(malformed.calls)).toEqual([]);

    const foreign = fakeInfisical({ unexpectedName: "UNRELATED_SECRET" });
    await expect(writer.syncStPrimaryBridgeWriter(syncOptions(foreign.fetcher))).resolves.toEqual({
      status: "error",
      errorCode: "scope_contains_unexpected_secret",
    });
    expect(writes(foreign.calls)).toEqual([]);
  });

  it("never advances the manifest or local watermark after a value-write failure", async () => {
    db.upsertUserApiKey(db.LOCAL_USER, "gemini", "gemini-current");
    const remote = fakeInfisical({ failWriteName: "GEMINI_API_KEY" });

    await expect(writer.syncStPrimaryBridgeWriter(syncOptions(remote.fetcher))).resolves.toEqual({
      status: "error",
      errorCode: "write_http_500",
    });
    expect(remote.store.has(MANIFEST)).toBe(false);
    expect(db.getInternalSetting(writer.ST_PRIMARY_BRIDGE_WRITER_STATE_KEY)).toBeUndefined();
  });

  it("advances beyond a persisted watermark when the remote path was rolled back", async () => {
    db.upsertUserApiKey(db.LOCAL_USER, "gemini", "gemini-current");
    db.setInternalSetting(writer.ST_PRIMARY_BRIDGE_WRITER_STATE_KEY, {
      schemaVersion: 1,
      sequence: 7,
      manifestDigest: "a".repeat(64),
    });
    const remote = fakeInfisical({
      initial: {
        GEMINI_API_KEY: "gemini-current",
        [MANIFEST]: manifest(
          3,
          { status: "active", value: "gemini-current" },
          { status: "revoked" }
        ),
      },
    });

    await expect(writer.syncStPrimaryBridgeWriter(syncOptions(remote.fetcher))).resolves.toMatchObject({
      status: "synced",
      sequence: 8,
    });
    expect(JSON.parse(remote.store.get(MANIFEST)!).sequence).toBe(8);
  });

  it("aborts manifest-last commit if another writer changes the observed generation", async () => {
    db.upsertUserApiKey(db.LOCAL_USER, "gemini", "gemini-new");
    const remote = fakeInfisical({
      initial: {
        GEMINI_API_KEY: "gemini-old",
        [MANIFEST]: manifest(
          1,
          { status: "active", value: "gemini-old" },
          { status: "revoked" }
        ),
      },
      beforeManifestRead(readNumber, store) {
        if (readNumber === 2) {
          store.set(MANIFEST, manifest(
            2,
            { status: "active", value: "gemini-new" },
            { status: "revoked" }
          ));
        }
      },
    });

    await expect(writer.syncStPrimaryBridgeWriter(syncOptions(remote.fetcher))).resolves.toEqual({
      status: "error",
      errorCode: "concurrent_manifest_change",
    });
    expect(writes(remote.calls).filter(({ name }) => name === MANIFEST)).toEqual([]);
  });

  it("does not record success if another writer changes an active value after commit", async () => {
    db.upsertUserApiKey(db.LOCAL_USER, "gemini", "gemini-current");
    const remote = fakeInfisical({
      initial: { GEMINI_API_KEY: "gemini-old" },
      afterWrite(name, store) {
        if (name === MANIFEST) store.set("GEMINI_API_KEY", "competing-writer-value");
      },
    });

    await expect(writer.syncStPrimaryBridgeWriter(syncOptions(remote.fetcher))).resolves.toEqual({
      status: "error",
      errorCode: "post_commit_value_mismatch",
    });
    expect(db.getInternalSetting(writer.ST_PRIMARY_BRIDGE_WRITER_STATE_KEY)).toBeUndefined();
  });

  it("drains a forced key mutation that arrives during an in-flight generation", async () => {
    db.upsertUserApiKey(db.LOCAL_USER, "gemini", "gemini-old");
    let releaseManifestRead!: () => void;
    const manifestReadGate = new Promise<void>((resolve) => {
      releaseManifestRead = resolve;
    });
    let reportManifestRead!: () => void;
    const manifestReadReached = new Promise<void>((resolve) => {
      reportManifestRead = resolve;
    });
    const remote = fakeInfisical({
      async beforeManifestRead(readNumber) {
        if (readNumber !== 1) return;
        reportManifestRead();
        await manifestReadGate;
      },
    });
    const options = syncOptions(remote.fetcher);

    const first = writer.runStPrimaryBridgeWriterIfDue({ ...options, force: true });
    await manifestReadReached;
    db.upsertUserApiKey(db.LOCAL_USER, "gemini", "gemini-new");
    const second = writer.runStPrimaryBridgeWriterIfDue({ ...options, force: true });
    releaseManifestRead();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "synced", sequence: 2 }),
      expect.objectContaining({ status: "synced", sequence: 2 }),
    ]);
    expect(remote.store.get("GEMINI_API_KEY")).toBe("gemini-new");
    expect(JSON.parse(remote.store.get(MANIFEST)!)).toEqual(JSON.parse(manifest(
      2,
      { status: "active", value: "gemini-new" },
      { status: "revoked" }
    )));
  });

  it("uses persisted cadence while an explicit tracked-key trigger bypasses it", async () => {
    const now = Date.parse("2026-07-15T15:00:00.000Z");
    db.setInternalSetting(
      writer.ST_PRIMARY_BRIDGE_WRITER_LAST_ATTEMPT_KEY,
      new Date(now).toISOString()
    );
    db.setInternalSetting(
      writer.ST_PRIMARY_BRIDGE_WRITER_LAST_SUCCESS_KEY,
      new Date(now).toISOString()
    );
    await expect(writer.runStPrimaryBridgeWriterIfDue({ enabled: true, now }))
      .resolves.toEqual({ status: "not_due" });
    await expect(writer.runStPrimaryBridgeWriterIfDue({ enabled: true, now, force: true }))
      .resolves.toEqual({ status: "unconfigured" });
  });

  it("retries after the persisted cadence clock is ahead of the current clock", async () => {
    const now = Date.parse("2026-07-15T15:00:00.000Z");
    db.setInternalSetting(
      writer.ST_PRIMARY_BRIDGE_WRITER_LAST_ATTEMPT_KEY,
      new Date(now + 60_000).toISOString()
    );
    db.setInternalSetting(
      writer.ST_PRIMARY_BRIDGE_WRITER_LAST_SUCCESS_KEY,
      new Date(now + 60_000).toISOString()
    );

    await expect(writer.runStPrimaryBridgeWriterIfDue({ enabled: true, now }))
      .resolves.toEqual({ status: "unconfigured" });
  });

  it("uses the retry cadence after a forced sync does not succeed", async () => {
    const now = Date.parse("2026-07-15T15:00:00.000Z");
    db.setInternalSetting(
      writer.ST_PRIMARY_BRIDGE_WRITER_LAST_ATTEMPT_KEY,
      new Date(now).toISOString()
    );
    db.setInternalSetting(
      writer.ST_PRIMARY_BRIDGE_WRITER_LAST_SUCCESS_KEY,
      new Date(now).toISOString()
    );
    await expect(writer.runStPrimaryBridgeWriterIfDue({ enabled: true, now, force: true }))
      .resolves.toEqual({ status: "unconfigured" });
    await expect(writer.runStPrimaryBridgeWriterIfDue({ enabled: true, now: now + 30_000 }))
      .resolves.toEqual({ status: "not_due" });
    await expect(writer.runStPrimaryBridgeWriterIfDue({ enabled: true, now: now + 60_000 }))
      .resolves.toEqual({ status: "unconfigured" });
  });

  it("contains an invalid scheduler clock as a stable error result", async () => {
    await expect(writer.runStPrimaryBridgeWriterIfDue({
      enabled: true,
      now: Number.NaN,
    })).resolves.toEqual({ status: "error", errorCode: "invalid_clock" });
  });
});
