import { NextResponse } from "next/server";
import { getEnrichmentProvider } from "@/lib/data-providers";
import { resolveRequestUser } from "@/lib/request-user";
import { enforceRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// On-demand single-symbol quote + fundamentals fetch for the console symbol drilldown
// (app/console/ui/symbol-drilldown.tsx), used ONLY when the last market scan didn't
// know the symbol — e.g. a recently traded or currently held name outside the scan
// universe. Read-only; consumes the SAME provider cascade the scan uses
// (src/lib/data-providers.ts getEnrichmentProvider), scoped to one symbol so it stays
// fast, and rides each provider's own internal short-TTL cache — no new cache infra
// here. Deliberately does NOT compute a composite score or factor breakdown: those
// rank a symbol against the scan's candidate universe and would be fabricated for a
// symbol fetched outside a scan run.

const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("symbol") ?? "";
  const symbol = raw.trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) {
    return NextResponse.json({ error: "invalid or missing symbol" }, { status: 400 });
  }

  const { userId } = resolveRequestUser(request);
  // Generous per-user cap: read-only and single-symbol, but still fans out to several
  // data providers, so guard against a tight refresh loop hammering upstreams.
  const limited = enforceRateLimit(userId, "quote", { limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const provider = getEnrichmentProvider(userId);
    // 12 s guard — a hung upstream shouldn't hang the drawer indefinitely; the client
    // renders a graceful failure note when this rejects.
    const results = await Promise.race([
      provider.enrich([symbol]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("quote fetch timed out")), 12_000)
      )
    ]);
    const enrichment = results[symbol] ?? {};
    return NextResponse.json({ symbol, ...enrichment });
  } catch (error) {
    const message = error instanceof Error ? error.message : "quote fetch failed";
    return NextResponse.json({ symbol, error: message }, { status: 502 });
  }
}
