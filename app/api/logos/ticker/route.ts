import { NextResponse } from "next/server";
import {
  logoDevTickerUrl,
  normalizeTickerLogoSymbol,
  tickerLogoCandidates,
  tickerLogoRawUrl,
  type LogoDevOptions
} from "@/lib/ticker-logos";

const ONE_DAY_SECONDS = 86_400;
const ONE_WEEK_SECONDS = 604_800;

async function fetchImage(
  url: string,
  revalidate: number,
  extraHeaders?: Record<string, string>
): Promise<{ buf: ArrayBuffer; contentType: string } | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      next: { revalidate },
      headers: extraHeaders
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.startsWith("image/")) return null;
  return { buf: await res.arrayBuffer(), contentType: "image/png" };
}

export async function GET(request: Request) {
  const { searchParams, protocol, host } = new URL(request.url);
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
  // Requires LOGO_DEV_TOKEN (publishable key). The Referer header is set to
  // this app's own origin so domain-restricted keys accept the request.
  const logoDevToken = process.env.LOGO_DEV_TOKEN;
  if (logoDevToken) {
    const baseSymbol = normalizeTickerLogoSymbol(rawSymbol);
    if (baseSymbol) {
      const rawTheme = searchParams.get("theme");
      const theme: LogoDevOptions["theme"] =
        rawTheme === "light" || rawTheme === "dark" ? rawTheme : "dark";

      const logoUrl = logoDevTickerUrl(baseSymbol, logoDevToken, { theme, fallback: "monogram" });
      const referer = `${protocol}//${host}/`;
      const result = await fetchImage(logoUrl, ONE_WEEK_SECONDS, { Referer: referer });
      if (result) {
        return new NextResponse(result.buf, {
          headers: {
            "cache-control": `public, max-age=${ONE_DAY_SECONDS}, stale-while-revalidate=${ONE_WEEK_SECONDS}`,
            "content-type": result.contentType,
            "x-logo-source": `logo.dev:ticker:${theme}`
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
