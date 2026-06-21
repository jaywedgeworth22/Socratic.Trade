import { NextResponse } from "next/server";
import { logoDevTickerUrl, normalizeTickerLogoSymbol, tickerLogoCandidates, tickerLogoRawUrl } from "@/lib/ticker-logos";

const ONE_DAY_SECONDS = 86_400;
const ONE_WEEK_SECONDS = 604_800;

async function fetchImage(url: string, revalidate: number): Promise<{ buf: ArrayBuffer; contentType: string } | null> {
  let res: Response;
  try {
    res = await fetch(url, { next: { revalidate } });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) return null;
  return { buf: await res.arrayBuffer(), contentType: "image/png" };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawSymbol = searchParams.get("symbol");
  const candidates = tickerLogoCandidates(rawSymbol);
  if (candidates.length === 0) {
    return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  }

  // ── Source 1: GitHub davidepalazzo/ticker-logos ───────────────────────────
  for (const symbol of candidates) {
    const result = await fetchImage(tickerLogoRawUrl(symbol), ONE_WEEK_SECONDS);
    if (result) {
      return new NextResponse(result.buf, {
        headers: {
          "cache-control": `public, max-age=${ONE_DAY_SECONDS}, stale-while-revalidate=${ONE_WEEK_SECONDS}`,
          "content-type": result.contentType,
          "x-logo-source": "github:davidepalazzo/ticker-logos"
        }
      });
    }
  }

  // ── Source 2: logo.dev — by ticker ────────────────────────────────────────
  // Activated when LOGO_DEV_TOKEN is set in .env.local.
  // Covers most publicly-traded equities; uses the normalised base symbol
  // (no variant permutations — logo.dev does its own matching).
  const logoDevToken = process.env.LOGO_DEV_TOKEN;
  if (logoDevToken) {
    const baseSymbol = normalizeTickerLogoSymbol(rawSymbol);
    if (baseSymbol) {
      const result = await fetchImage(logoDevTickerUrl(baseSymbol, logoDevToken), ONE_WEEK_SECONDS);
      if (result) {
        return new NextResponse(result.buf, {
          headers: {
            "cache-control": `public, max-age=${ONE_DAY_SECONDS}, stale-while-revalidate=${ONE_WEEK_SECONDS}`,
            "content-type": result.contentType,
            "x-logo-source": "logo.dev:ticker"
          }
        });
      }
    }
  }

  return new NextResponse(null, {
    status: 404,
    headers: { "cache-control": `public, max-age=${ONE_DAY_SECONDS}` }
  });
}
