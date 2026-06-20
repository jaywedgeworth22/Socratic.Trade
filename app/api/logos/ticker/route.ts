import { NextResponse } from "next/server";
import { tickerLogoCandidates, tickerLogoRawUrl } from "@/lib/ticker-logos";

const ONE_DAY_SECONDS = 86_400;
const ONE_WEEK_SECONDS = 604_800;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const candidates = tickerLogoCandidates(searchParams.get("symbol"));
  if (candidates.length === 0) {
    return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  }

  for (const symbol of candidates) {
    let upstream: Response;
    try {
      upstream = await fetch(tickerLogoRawUrl(symbol), {
        next: { revalidate: ONE_WEEK_SECONDS }
      });
    } catch {
      continue;
    }
    if (!upstream.ok) continue;

    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/png")) continue;

    return new NextResponse(await upstream.arrayBuffer(), {
      headers: {
        "cache-control": `public, max-age=${ONE_DAY_SECONDS}, stale-while-revalidate=${ONE_WEEK_SECONDS}`,
        "content-type": "image/png",
        "x-logo-source": "github:davidepalazzo/ticker-logos"
      }
    });
  }

  return new NextResponse(null, {
    status: 404,
    headers: {
      "cache-control": `public, max-age=${ONE_DAY_SECONDS}`
    }
  });
}
