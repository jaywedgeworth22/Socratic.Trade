import { NextResponse } from "next/server";
import { audit } from "@/lib/db";
import {
  getImportedCacheCounts,
  persistSecuritiesImport,
  type ImportedCloseInput,
  type ImportedPriceInput,
  type ImportedRefInput
} from "@/lib/db-securities-import";
import { verifySecuritiesImportToken } from "@/lib/securities-import-auth";
import { APP_B_ORIGIN } from "@/lib/congress-share";

export const dynamic = "force-dynamic";

// Inbound securities-import receiver for the congress.trade (App A) return-path (App B side).
//
// App A independently fetches price/spx/ref data; this endpoint lets it push those gap-fills back to
// us so they warm App B's local EOD cache and displace a re-fetch (see the optional cache-aside tier
// in fetchDailyOHLC). Symmetric with the body App B already POSTs to App A's import endpoint.
//
// Auth: bearer APP_B_INGEST_TOKEN, constant-time. DEFAULT-CLOSED — with no token configured every
// write is rejected. No-echo guard: a payload tagged with App B's own origin is acked but NOT stored
// (so a round-trip of our own outbound push is a no-op). insider/shortVolume are accepted-and-ignored
// on the inbound path (gap-fills are prices/spx/refs only).
//
// Body (all optional): { refs?, prices?, spx?, origin? } — the same shape as App B's outbound push.
export async function POST(req: Request) {
  if (!verifySecuritiesImportToken(req)) {
    audit("securities_import_rejected", { reason: "token" });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  // No-echo guard: never re-store rows we originated.
  const origin = typeof rec.origin === "string" && rec.origin.trim() ? rec.origin.trim() : "app-a";
  if (origin === APP_B_ORIGIN) {
    return NextResponse.json({ ok: true, skipped: true, reason: "own-origin", refs: 0, pricedTickers: 0, priceRows: 0, spxRows: 0 });
  }

  try {
    const refs = coerceRefs(rec.refs);
    const prices = coercePrices(rec.prices);
    const spx = coerceCloses(rec.spx);
    const result = persistSecuritiesImport({ refs, prices, spx }, origin);
    audit("securities_import", { origin, ...result });
    return NextResponse.json({ ok: true, origin, ...result, totals: getImportedCacheCounts() });
  } catch (error) {
    audit("securities_import_error", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ ok: false, error: "ingest failed" }, { status: 500 });
  }
}

// ── Tolerant coercion (extra keys ignored; bad rows dropped; never throws on shape) ──

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function coerceRefs(value: unknown): ImportedRefInput[] {
  if (!Array.isArray(value)) return [];
  const out: ImportedRefInput[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const ticker = str(r.ticker);
    if (!ticker) continue;
    out.push({
      ticker,
      companyName: str(r.companyName),
      sector: str(r.sector),
      industry: str(r.industry),
      assetClass: str(r.assetClass),
      exchange: str(r.exchange) ?? str(r.exchangeShort),
      currency: str(r.currency),
      marketCap: num(r.marketCap),
      cik: str(r.cik)
    });
  }
  return out;
}

function coerceCloses(value: unknown): ImportedCloseInput[] {
  if (!Array.isArray(value)) return [];
  const out: ImportedCloseInput[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const date = str(c.date);
    const close = num(c.close);
    if (!date || close === undefined) continue;
    out.push({ date, close, volume: num(c.volume) });
  }
  return out;
}

function coercePrices(value: unknown): ImportedPriceInput[] {
  if (!Array.isArray(value)) return [];
  const out: ImportedPriceInput[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const ticker = str(p.ticker);
    if (!ticker) continue;
    out.push({ ticker, closes: coerceCloses(p.closes) });
  }
  return out;
}
