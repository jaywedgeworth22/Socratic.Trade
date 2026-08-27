// Native iOS web-auth initiation (GET) tests.
//
// The iOS app's ASWebAuthenticationSession can only perform a top-level GET
// navigation, but Auth.js v5 initiates OAuth solely on POST — a GET of
// /api/auth/signin/<provider> is an UnknownAction that dead-ends on
// /access-denied?error=Configuration.  Two pieces bridge that gap:
//   1. middleware.ts translates GET /api/auth/signin/<provider> into
//      /api/mobile/auth-start (keeps already-shipped iOS builds working).
//   2. app/api/mobile/auth-start/route.ts validates provider + callback and
//      calls the server-side signIn(), which performs the real redirect.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const signInMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/auth", () => ({ signIn: signInMock }));

async function loadMiddleware() {
  const mod = await import("../middleware.js");
  return mod.middleware as (req: NextRequest) => Promise<import("next/server").NextResponse>;
}

function makeRequest(path: string): NextRequest {
  return new NextRequest(`https://trading.example.com${path}`);
}

describe("middleware GET /api/auth/signin/<provider> translation", () => {
  it("redirects the legacy iOS entry to /api/mobile/auth-start with provider + callbackUrl", async () => {
    const middleware = await loadMiddleware();
    const res = await middleware(
      makeRequest(
        "/api/auth/signin/google?callbackUrl=https%3A%2F%2Ftrading.example.com%2Fapi%2Fmobile%2Fauth-redirect%3Fcode_challenge%3Dabc"
      )
    );
    expect([302, 307]).toContain(res.status);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/api/mobile/auth-start");
    expect(location.searchParams.get("provider")).toBe("google");
    expect(location.searchParams.get("callbackUrl")).toBe(
      "https://trading.example.com/api/mobile/auth-redirect?code_challenge=abc"
    );
  });

  it("redirects a provider entry without callbackUrl and omits the param", async () => {
    const middleware = await loadMiddleware();
    const res = await middleware(makeRequest("/api/auth/signin/github"));
    expect([302, 307]).toContain(res.status);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/api/mobile/auth-start");
    expect(location.searchParams.get("provider")).toBe("github");
    expect(location.searchParams.has("callbackUrl")).toBe(false);
  });

  it("does not translate nested or empty provider segments", async () => {
    const middleware = await loadMiddleware();
    const nested = await middleware(makeRequest("/api/auth/signin/google/extra"));
    const nestedLocation = nested.headers.get("location") ?? "";
    expect(nestedLocation).not.toContain("/api/mobile/auth-start");
  });
});

describe("/api/mobile/auth-start route", () => {
  beforeEach(() => {
    signInMock.mockReset();
  });

  async function loadRoute() {
    const mod = await import("../app/api/mobile/auth-start/route");
    return mod.GET;
  }

  it("rethrows the NEXT_REDIRECT thrown by signIn (the success path)", async () => {
    const GET = await loadRoute();
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;https://accounts.google.com/o/oauth2/v2/auth?x=1;307;"
    });
    signInMock.mockRejectedValueOnce(redirectError);
    await expect(
      GET(
        new Request(
          "https://trading.example.com/api/mobile/auth-start?provider=google&callbackUrl=https%3A%2F%2Ftrading.example.com%2Fapi%2Fmobile%2Fauth-redirect%3Fcode_challenge%3Dabc"
        )
      )
    ).rejects.toBe(redirectError);
    expect(signInMock).toHaveBeenCalledWith("google", {
      redirectTo: "/api/mobile/auth-redirect?code_challenge=abc"
    });
  });

  it("clamps a cross-origin callbackUrl to /", async () => {
    const GET = await loadRoute();
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;https://accounts.google.com/o/oauth2/v2/auth?x=1;307;"
    });
    signInMock.mockRejectedValueOnce(redirectError);
    await expect(
      GET(
        new Request(
          "https://trading.example.com/api/mobile/auth-start?provider=google&callbackUrl=https%3A%2F%2Fevil.example.net%2Fphish"
        )
      )
    ).rejects.toBe(redirectError);
    expect(signInMock).toHaveBeenCalledWith("google", { redirectTo: "/" });
  });

  it("sends unknown providers to /login with the callback preserved", async () => {
    const GET = await loadRoute();
    const res = await GET(
      new Request("https://trading.example.com/api/mobile/auth-start?provider=evil&callbackUrl=%2Fconsole")
    );
    expect(signInMock).not.toHaveBeenCalled();
    expect([302, 307]).toContain(res.status);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("callbackUrl")).toBe("/console");
  });

  it("falls back to /login when signIn fails for real (provider unconfigured)", async () => {
    const GET = await loadRoute();
    signInMock.mockRejectedValueOnce(new Error("provider is not configured"));
    const res = await GET(
      new Request("https://trading.example.com/api/mobile/auth-start?provider=github&callbackUrl=%2Fconsole")
    );
    expect([302, 307]).toContain(res.status);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("callbackUrl")).toBe("/console");
  });
});
