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
// (so a round-trip of our own outbound push is a no-op).
//
// DIRECTIONAL ASYMMETRY (why only 3 of the 7 shared SharePayload slots are persisted here — by design;
// see docs/congress-trade-consume.md §4 and docs/congress-trade-share.md):
//   - refs / prices / spx  -> PERSISTED (imported_securities_ref / imported_price_eod / imported_spx_eod).
//     These are App A -> App B gap-fills that warm App B's local EOD cache.
//   - insider / shortVolume -> App B is the AUTHORITATIVE source (it computes these from SEC/FINRA and
//     pushes them TO App A); App A never echoes better values back, so there is nothing to store here.
//   - fundamentals / analyst -> App B reads these from App A on demand via the PULL enrichment tier
//     (CongressTradeEnrichmentProvider, 6h cache), not this import path.
// Any of the four non-persisted datasets that DO arrive are ACKNOWLEDGED in the response
// (`acceptedNotPersisted`) rather than silently dropped, so a future contract change surfaces instead
// of losing data quietly.
//
// Body (all optional): { refs?, prices?, spx?, insider?, shortVolume?, fundamentals?, analyst?, origin? }
// — the same shape as App B's outbound push (only refs/prices/spx are stored inbound).
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

    // Explicitly acknowledge any non-persisted datasets that arrived, so nothing is silently
    // discarded (see the directional-asymmetry note in the file header).
    const acceptedNotPersisted: Record<string, number> = {};
    for (const key of ["insider", "shortVolume", "fundamentals", "analyst"] as const) {
      const arr = rec[key];
      if (Array.isArray(arr) && arr.length > 0) acceptedNotPersisted[key] = arr.length;
    }

    const result = persistSecuritiesImport({ refs, prices, spx }, origin);
    audit("securities_import", { origin, ...result, acceptedNotPersisted });
    return NextResponse.json({
      ok: true,
      origin,
      ...result,
      totals: getImportedCacheCounts(),
      ...(Object.keys(acceptedNotPersisted).length > 0
        ? {
            acceptedNotPersisted,
            note: "insider/shortVolume are App-B-authoritative; fundamentals/analyst are pulled on demand — not persisted on the inbound import path by design",
          }
        : {}),
    });
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
