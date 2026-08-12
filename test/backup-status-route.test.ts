import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GET } from "../app/api/admin/backup-status/route";
import { AUTHENTICATED_EMAIL_HEADER } from "../src/lib/request-user";
import {
  AUTHENTICATED_IDENTITY_SOURCE_HEADER,
  AUTHENTICATED_IDENTITY_SOURCES
} from "../src/lib/auth/strip-identity";

// Covers app/admin/backups/ — the admin-only route backing the new per-tier backup status
// panel. Read-only projection of the same src/lib/runtime-health.ts signals /api/health
// exposes publicly, reshaped for the UI. See test/runtime-health.test.ts for the underlying
// assessLitestreamTierFreshness unit coverage and test/connection-health-routing.test.ts for
// the /api/health wiring coverage.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-backup-status-${randomUUID()}.db`)}`;
});

function reqWithEmail(email?: string): Request {
  const headers: Record<string, string> = {};
  if (email) {
    headers[AUTHENTICATED_EMAIL_HEADER] = email;
    headers[AUTHENTICATED_IDENTITY_SOURCE_HEADER] = AUTHENTICATED_IDENTITY_SOURCES.authJsSession;
  }
  return new Request("https://socratictrade.com/api/admin/backup-status", { method: "GET", headers });
}

describe("/api/admin/backup-status", () => {
  afterEach(() => {
    delete process.env.ADMIN_USER_EMAILS;
    delete process.env.DB_BOOTSTRAP;
    delete process.env.LITESTREAM_SOCKET_PATH;
    delete process.env.LITESTREAM_STATE_PATH;
  });

  it("denies a non-admin caller", async () => {
    process.env.ADMIN_USER_EMAILS = "admin@example.com";
    const res = await GET(reqWithEmail("someone-else@example.com"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("denies an unauthenticated caller", async () => {
    process.env.ADMIN_USER_EMAILS = "admin@example.com";
    const res = await GET(reqWithEmail());
    expect(res.status).toBe(403);
  });

  it("returns the overall signal and all three tiers, gracefully unknown when litestream isn't running", async () => {
    process.env.ADMIN_USER_EMAILS = "admin@example.com";
    const stateRoot = mkdtempSync(join(tmpdir(), "backup-status-route-missing-"));
    try {
      process.env.LITESTREAM_SOCKET_PATH = join(stateRoot, "missing.sock");
      process.env.LITESTREAM_STATE_PATH = join(stateRoot, "not-created");

      const res = await GET(reqWithEmail("admin@example.com"));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.overall).toMatchObject({ state: "unknown", source: "none", degraded: false });
      expect(body.tiers).toHaveLength(5);
      for (const tier of body.tiers) {
        expect(tier.state).toBe("unknown");
      }
      expect(body.tiersDegraded).toBe(false);
      expect(typeof body.statePath).toBe("string");
      expect(Number.isFinite(Date.parse(body.asOf))).toBe(true);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("surfaces a degraded level-1 tier while level 0 and level 9 report healthy", async () => {
    process.env.ADMIN_USER_EMAILS = "admin@example.com";
    const stateRoot = mkdtempSync(join(tmpdir(), "backup-status-route-degraded-"));
    try {
      const writeTierFile = (tier: "0" | "1" | "9", mtime: Date) => {
        const dir = join(stateRoot, "ltx", tier);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${tier}.ltx`);
        writeFileSync(file, "ltx");
        utimesSync(file, mtime, mtime);
      };
      const now = new Date();
      writeTierFile("0", new Date(now.getTime() - 30_000));
      writeTierFile("1", new Date(now.getTime() - 27 * 3_600_000));
      writeTierFile("9", new Date(now.getTime() - 10 * 3_600_000));

      process.env.LITESTREAM_SOCKET_PATH = join(stateRoot, "missing.sock");
      process.env.LITESTREAM_STATE_PATH = stateRoot;

      const res = await GET(reqWithEmail("admin@example.com"));
      expect(res.status).toBe(200);
      const body = await res.json();

      const byTier = Object.fromEntries(body.tiers.map((t: { tier: string }) => [t.tier, t]));
      expect(byTier["0"]).toMatchObject({ state: "known", degraded: false });
      expect(byTier["1"]).toMatchObject({ state: "known", degraded: true });
      expect(byTier["9"]).toMatchObject({ state: "known", degraded: false });
      expect(body.tiersDegraded).toBe(true);
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});
