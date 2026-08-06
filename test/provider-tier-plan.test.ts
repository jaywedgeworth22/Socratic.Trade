import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  defaultPlanTierForService,
  isRetiredMarketDataService,
  isValidPlanTierForService,
  planTierOptionsForService,
  quotaWindowsForPlan,
  rateLimitProviderName
} from "../src/lib/provider-tier-plan";
import { resolveProviderQuota, resetProviderQuotaState } from "../src/lib/provider-rate-limit";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MINUTE = 60_000;

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-provider-tier-plan-${randomUUID()}.db`)}`;
});

describe("provider-tier-plan mapping", () => {
  it("exposes free/power options for tiingo and free default", () => {
    const opts = planTierOptionsForService("tiingo");
    expect(opts?.map((o) => o.id)).toEqual(expect.arrayContaining(["free", "power", "unknown"]));
    expect(defaultPlanTierForService("tiingo")).toBe("free");
    expect(isValidPlanTierForService("tiingo", "power")).toBe(true);
    expect(isValidPlanTierForService("tiingo", "enterprise")).toBe(false);
  });

  it("does not attach plan tiers to LLM keys", () => {
    expect(planTierOptionsForService("openrouter")).toBeNull();
    expect(planTierOptionsForService("pinecone")).toBeNull();
    expect(planTierOptionsForService("voyage")).toBeNull();
  });

  it("maps tiingo free vs power to documented quota windows", () => {
    const free = quotaWindowsForPlan("tiingo", "free")!;
    expect(free).toEqual(
      expect.arrayContaining([
        { maxRequests: 50, windowMs: HOUR },
        { maxRequests: 1000, windowMs: DAY }
      ])
    );
    const power = quotaWindowsForPlan("tiingo", "power")!;
    expect(power).toEqual(
      expect.arrayContaining([
        { maxRequests: 10_000, windowMs: HOUR },
        { maxRequests: 100_000, windowMs: DAY }
      ])
    );
  });

  it("maps marketstack basic to ~333/day and marks FMP retired", () => {
    expect(quotaWindowsForPlan("marketstack", "basic")).toEqual([{ maxRequests: 333, windowMs: DAY }]);
    expect(isRetiredMarketDataService("fmp")).toBe(true);
    expect(isRetiredMarketDataService("tiingo")).toBe(false);
  });

  it("maps ROIC free vs individual quotas and plan options", () => {
    expect(planTierOptionsForService("roic")?.map((o) => o.id)).toEqual(
      expect.arrayContaining(["free", "starter", "individual", "professional", "unknown"])
    );
    expect(quotaWindowsForPlan("roic", "free")).toEqual([{ maxRequests: 300, windowMs: DAY }]);
    expect(quotaWindowsForPlan("roic", "individual")).toEqual([{ maxRequests: 10_000, windowMs: DAY }]);
  });

  it("normalizes alpha-vantage provider name to alphavantage service", () => {
    expect(rateLimitProviderName("alphavantage")).toBe("alpha-vantage");
    expect(quotaWindowsForPlan("alpha-vantage", "free")).toEqual([{ maxRequests: 25, windowMs: DAY }]);
  });
});

describe("resolveProviderQuota uses plan tier when env knobs unset", () => {
  it("raises tiingo caps when planTier=power is passed", () => {
    delete process.env.PROVIDER_QUOTA_TIINGO_PER_HOUR;
    delete process.env.PROVIDER_QUOTA_TIINGO_PER_DAY;
    resetProviderQuotaState("tiingo");

    const freeish = resolveProviderQuota("tiingo", "free")!;
    const hourFree = freeish.find((w) => w.windowMs === HOUR);
    expect(hourFree?.maxRequests).toBe(50);

    const power = resolveProviderQuota("tiingo", "power")!;
    const hourPower = power.find((w) => w.windowMs === HOUR);
    expect(hourPower?.maxRequests).toBe(10_000);
    const dayPower = power.find((w) => w.windowMs === DAY);
    expect(dayPower?.maxRequests).toBe(100_000);
  });

  it("lets PROVIDER_QUOTA_* env override tier windows", () => {
    delete process.env.PROVIDER_QUOTA_TIINGO_PER_HOUR;
    process.env.PROVIDER_QUOTA_TIINGO_PER_DAY = "42";
    try {
      const windows = resolveProviderQuota("tiingo", "power")!;
      const day = windows.find((w) => w.windowMs === DAY);
      expect(day?.maxRequests).toBe(42);
      // Hour still from power tier when only day env is set
      const hour = windows.find((w) => w.windowMs === HOUR);
      expect(hour?.maxRequests).toBe(10_000);
    } finally {
      delete process.env.PROVIDER_QUOTA_TIINGO_PER_DAY;
    }
  });

  it("uses grow tier minute credits for twelvedata", () => {
    delete process.env.PROVIDER_QUOTA_TWELVEDATA_PER_MIN;
    delete process.env.TWELVEDATA_CREDITS_PER_MIN;
    const grow = resolveProviderQuota("twelvedata", "grow")!;
    expect(grow.find((w) => w.windowMs === MINUTE)?.maxRequests).toBe(377);
    // Grow has no daily cap in the tier map
    expect(grow.find((w) => w.windowMs === DAY)).toBeUndefined();
  });
});

describe("plan_tier persistence on user_api_keys", () => {
  it("stores and updates plan_tier without re-pasting the secret", async () => {
    const { getDb, upsertUserApiKey, setUserApiKeyPlanTier, getUserApiKey, LOCAL_USER } = await import(
      "../src/lib/db"
    );
    getDb();
    upsertUserApiKey(LOCAL_USER, "tiingo", "tiingo-test-key-aaaaaaaa", "lab", "free");
    const first = getUserApiKey(LOCAL_USER, "tiingo");
    expect(first?.planTier).toBe("free");
    expect(first?.apiKey).toBe("tiingo-test-key-aaaaaaaa");

    const updated = setUserApiKeyPlanTier(LOCAL_USER, "tiingo", "power");
    expect(updated?.planTier).toBe("power");
    expect(getUserApiKey(LOCAL_USER, "tiingo")?.planTier).toBe("power");
    // Secret unchanged
    expect(getUserApiKey(LOCAL_USER, "tiingo")?.apiKey).toBe("tiingo-test-key-aaaaaaaa");
  });

  it("preserves plan_tier when replacing the key without a new tier", async () => {
    const { getDb, upsertUserApiKey, getUserApiKey, LOCAL_USER } = await import("../src/lib/db");
    getDb();
    upsertUserApiKey(LOCAL_USER, "twelvedata", "td-key-1-bbbbbbbb", undefined, "grow");
    upsertUserApiKey(LOCAL_USER, "twelvedata", "td-key-2-cccccccc");
    expect(getUserApiKey(LOCAL_USER, "twelvedata")?.planTier).toBe("grow");
    expect(getUserApiKey(LOCAL_USER, "twelvedata")?.apiKey).toBe("td-key-2-cccccccc");
  });

  it("lookup via resolveProviderQuota reads stored operator plan_tier", async () => {
    delete process.env.PROVIDER_QUOTA_TIINGO_PER_HOUR;
    delete process.env.PROVIDER_QUOTA_TIINGO_PER_DAY;
    const { getDb, upsertUserApiKey, setUserApiKeyPlanTier, LOCAL_USER } = await import("../src/lib/db");
    getDb();
    upsertUserApiKey(LOCAL_USER, "tiingo", "tiingo-lookup-key-dddddddd", undefined, "free");
    setUserApiKeyPlanTier(LOCAL_USER, "tiingo", "power");
    const windows = resolveProviderQuota("tiingo"); // no explicit tier — reads DB
    expect(windows?.find((w) => w.windowMs === HOUR)?.maxRequests).toBe(10_000);
  });
});

describe("GET/POST /api/keys planTier surface", () => {
  it("returns planTierOptions for market-data and retired flag for fmp", async () => {
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    const { getDb, upsertUserApiKey } = await import("../src/lib/db");
    const { userIdForEmail } = await import("../src/lib/auth/identity");
    getDb();
    const userId = userIdForEmail("owner@example.com");
    upsertUserApiKey(userId, "finnhub", "finnhub-key-eeeeeeee", undefined, "free");

    const { NextRequest } = await import("next/server");
    const { GET } = await import("../app/api/keys/route");
    const res = await GET(
      new NextRequest("http://localhost/api/keys", {
        headers: {
          "x-authenticated-user-email": "owner@example.com",
          "x-authenticated-identity-source": "authjs-session"
        }
      })
    );
    const body = (await res.json()) as {
      keys: Array<{
        service: string;
        planTier?: string;
        planTierOptions?: Array<{ id: string }>;
        retired?: boolean;
      }>;
    };
    const finnhub = body.keys.find((k) => k.service === "finnhub")!;
    expect(finnhub.planTier).toBe("free");
    expect(finnhub.planTierOptions?.some((o) => o.id === "free")).toBe(true);

    const openrouter = body.keys.find((k) => k.service === "openrouter")!;
    expect(openrouter.planTierOptions).toBeUndefined();

    const fmp = body.keys.find((k) => k.service === "fmp")!;
    expect(fmp.retired).toBe(true);
  });

  it("POST planTier alone updates stored tier", async () => {
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner2@example.com");
    const { getDb, upsertUserApiKey, getUserApiKey } = await import("../src/lib/db");
    const { userIdForEmail } = await import("../src/lib/auth/identity");
    getDb();
    const userId = userIdForEmail("owner2@example.com");
    upsertUserApiKey(userId, "marketstack", "ms-key-ffffffffffff", undefined, "free");

    const { NextRequest } = await import("next/server");
    const { POST } = await import("../app/api/keys/route");
    const res = await POST(
      new NextRequest("http://localhost/api/keys", {
        method: "POST",
        headers: {
          "x-authenticated-user-email": "owner2@example.com",
          "x-authenticated-identity-source": "authjs-session",
          "content-type": "application/json"
        },
        body: JSON.stringify({ service: "marketstack", planTier: "basic" })
      })
    );
    expect(res.status).toBe(200);
    expect(getUserApiKey(userId, "marketstack")?.planTier).toBe("basic");
  });
});
