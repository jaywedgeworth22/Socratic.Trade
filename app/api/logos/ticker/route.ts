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
const FETCH_TIMEOUT_MS = 5_000;

async function fetchImage(
  url: string,
  revalidate: number,
  extraHeaders?: Record<string, string>
): Promise<{ buf: ArrayBuffer; contentType: string } | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      next: { revalidate },
      headers: extraHeaders,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
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

  const logoDevToken = process.env.LOGO_DEV_TOKEN;
  const baseSymbol = normalizeTickerLogoSymbol(rawSymbol);
  const rawTheme = searchParams.get("theme");
  const theme: LogoDevOptions["theme"] =
    rawTheme === "light" || rawTheme === "dark" ? rawTheme : "dark";

  async function tryGitHub() {
    for (const sym of candidates) {
      const r = await fetchImage(tickerLogoRawUrl(sym), ONE_WEEK_SECONDS);
      if (r) return new NextResponse(r.buf, {
        headers: {
          "cache-control": `public, max-age=${ONE_DAY_SECONDS}, stale-while-revalidate=${ONE_WEEK_SECONDS}`,
          "content-type": r.contentType,
          "x-logo-source": "github:davidepalazzo/ticker-logos"
        }
      });
    }
    return null;
  }

  async function tryLogoDev() {
    if (!logoDevToken || !baseSymbol) return null;
    const logoUrl = logoDevTickerUrl(baseSymbol, logoDevToken, { theme, fallback: "monogram" });
    const referer = `${protocol}//${host}/`;
    const r = await fetchImage(logoUrl, ONE_WEEK_SECONDS, { Referer: referer });
    if (!r) return null;
    return new NextResponse(r.buf, {
      headers: {
        "cache-control": `public, max-age=${ONE_DAY_SECONDS}, stale-while-revalidate=${ONE_WEEK_SECONDS}`,
        "content-type": r.contentType,
        "x-logo-source": `logo.dev:ticker:${theme}`
      }
    });
  }

  const result = (await tryGitHub()) ?? (await tryLogoDev());

  return result ?? new NextResponse(null, {
    status: 404,
    headers: { "cache-control": `public, max-age=${ONE_DAY_SECONDS}` }
  });
}
