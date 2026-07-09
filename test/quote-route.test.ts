import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/data-providers", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/data-providers")>();
  return { ...actual, getEnrichmentProvider: vi.fn() };
});
vi.mock("@/lib/rate-limit", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/rate-limit")>();
  return { ...actual, enforceRateLimit: vi.fn(() => null) };
});

import { getEnrichmentProvider } from "@/lib/data-providers";
import { enforceRateLimit } from "@/lib/rate-limit";

describe("/api/quote", () => {
  beforeEach(() => {
    vi.mocked(enforceRateLimit).mockReturnValue(null);
  });

  it("returns the single-symbol enrichment record merged with the symbol", async () => {
    vi.mocked(getEnrichmentProvider).mockReturnValue({
      name: "test",
      configured: true,
      enrich: vi.fn().mockResolvedValue({
        LRCX: { price: 78.2, peRatio: 24.1, sector: "Technology", sources: { price: "yahoo-finance" } }
      })
    });
    const { GET } = await import("../app/api/quote/route");

    const response = await GET(new Request("http://localhost/api/quote?symbol=lrcx"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.symbol).toBe("LRCX");
    expect(body.price).toBe(78.2);
    expect(body.peRatio).toBe(24.1);
  });

  it("rejects an invalid or missing symbol without calling the provider", async () => {
    const enrich = vi.fn();
    vi.mocked(getEnrichmentProvider).mockReturnValue({ name: "test", configured: true, enrich });
    const { GET } = await import("../app/api/quote/route");

    const response = await GET(new Request("http://localhost/api/quote?symbol=" + encodeURIComponent("bad symbol!")));
    expect(response.status).toBe(400);
    expect(enrich).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(enforceRateLimit).mockReturnValue(new Response(JSON.stringify({ ok: false }), { status: 429 }));
    const { GET } = await import("../app/api/quote/route");

    const response = await GET(new Request("http://localhost/api/quote?symbol=LRCX"));
    expect(response.status).toBe(429);
  });

  it("degrades to a 502 with the symbol echoed back when the provider throws", async () => {
    vi.mocked(getEnrichmentProvider).mockReturnValue({
      name: "test",
      configured: true,
      enrich: vi.fn().mockRejectedValue(new Error("upstream down"))
    });
    const { GET } = await import("../app/api/quote/route");

    const response = await GET(new Request("http://localhost/api/quote?symbol=LRCX"));
    const body = await response.json();
    expect(response.status).toBe(502);
    expect(body.symbol).toBe("LRCX");
  });
});
