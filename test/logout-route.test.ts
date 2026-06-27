import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /logout", () => {
  it("routes Cloudflare Access logout through the public host when the app sees localhost internally", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    const { GET } = await import("../app/logout/route");

    const response = await GET(
      new NextRequest("http://localhost:4000/logout", {
        headers: { "x-forwarded-host": "trading.jays.services" }
      })
    );
    const location = response.headers.get("location");

    expect(location).toBe(
      "https://trading.jays.services/cdn-cgi/access/logout?returnTo=https%3A%2F%2Ftrading.jays.services%2Flogin"
    );
  });

  it("uses the configured public site URL for Cloudflare Access logout when forwarded headers are absent", async () => {
    vi.stubEnv("CF_ACCESS_TRUST_EMAIL_HEADER", "1");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://trading.jays.services");
    const { GET } = await import("../app/logout/route");

    const response = await GET(new NextRequest("http://localhost:4000/logout"));

    expect(response.headers.get("location")).toBe(
      "https://trading.jays.services/cdn-cgi/access/logout?returnTo=https%3A%2F%2Ftrading.jays.services%2Flogin"
    );
  });
});
