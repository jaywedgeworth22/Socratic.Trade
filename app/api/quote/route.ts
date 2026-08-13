import { NextResponse } from "next/server";
import { enrichYahooFinanceSymbol, getEnrichmentProvider, type SymbolEnrichment } from "@/lib/data-providers";
import {
  composeOnDemandQuote,
  enrichmentHasValues,
  fastQuoteEnrichment,
  loadDurableQuoteSeed,
  persistOnDemandQuote
} from "@/lib/on-demand-quote";
import { resolveRequestUser } from "@/lib/request-user";
import { enforceRateLimit } from "@/lib/rate-limit";
import { runQuoteEnrichmentSingleFlight } from "@/lib/quote-singleflight";
import { fetchYahooFinanceQuote } from "@/lib/yahoo-finance";

export const dynamic = "force-dynamic";

// On-demand single-symbol quote + fundamentals fetch for the console symbol drilldown
// (app/console/ui/symbol-drilldown.tsx) and the iOS SymbolInfoSheet. Used when the last
// market scan didn't know the symbol — or when the sheet needs a live refresh.
//
// Four layers, started together:
// 1. Durable store — last saved PE/EPS/div/52w (the "see / save / update" path).
// 2. Keyless Yahoo chart — identity + price/volume + 52-week range (already on meta).
// 3. Yahoo quoteSummary only — PE/EPS/div/beta without waiting for paid/scarce waves.
// 4. Full provider cascade — wins extra fields when it finishes in time.
//
// Deliberately does NOT compute a composite score or factor breakdown: those rank a
// symbol against the scan's candidate universe and would be fabricated for a symbol
// fetched outside a scan run.

const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const CASCADE_BUDGET_MS = 6_000;

type EnrichmentOutcome =
  | { status: "ready"; data: SymbolEnrichment }
  | { status: "failed"; error: unknown };
type BudgetedOutcome = EnrichmentOutcome | { status: "timed-out" };

function withinBudget(promise: Promise<EnrichmentOutcome>, budgetMs: number): Promise<BudgetedOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve({ status: "timed-out" });
    }, budgetMs);
    void promise.then((outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    });
  });
}

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

  const richPromise: Promise<EnrichmentOutcome> = runQuoteEnrichmentSingleFlight(
    `${userId}:${symbol}`,
    async () => (await getEnrichmentProvider(userId).enrich([symbol]))[symbol] ?? {}
  )
    .then((data) => ({ status: "ready" as const, data }))
    .catch((error) => ({ status: "failed" as const, error }));
  const fastPromise = fetchYahooFinanceQuote(symbol)
    .then((quote): EnrichmentOutcome =>
      quote
        ? { status: "ready", data: fastQuoteEnrichment(quote) }
        : { status: "failed", error: new Error("no current quote returned") }
    )
    .catch((error) => ({ status: "failed" as const, error }));
  const yahooPromise: Promise<EnrichmentOutcome> = enrichYahooFinanceSymbol(symbol)
    .then((data) => ({ status: "ready" as const, data }))
    .catch((error) => ({ status: "failed" as const, error }));

  const [durable, fast, yahoo, rich] = await Promise.all([
    loadDurableQuoteSeed(symbol),
    fastPromise,
    withinBudget(yahooPromise, CASCADE_BUDGET_MS),
    withinBudget(richPromise, CASCADE_BUDGET_MS)
  ]);
  const fastData = fast.status === "ready" ? fast.data : {};
  const yahooData = yahoo.status === "ready" ? yahoo.data : {};
  const richData = rich.status === "ready" ? rich.data : {};
  const enrichment = composeOnDemandQuote([durable, fastData, yahooData, richData]);

  const hasLiveQuote =
    fast.status === "ready"
    || (yahoo.status === "ready" && enrichmentHasValues(yahooData))
    || (rich.status === "ready" && enrichmentHasValues(richData));
  if (hasLiveQuote || enrichmentHasValues(durable)) {
    persistOnDemandQuote(symbol, enrichment);
    return NextResponse.json({ symbol, ...enrichment });
  }

  const error = rich.status === "failed" ? rich.error : fast.error;
  const message = rich.status === "timed-out" && yahoo.status === "timed-out"
    ? "quote fetch timed out"
    : error instanceof Error
      ? error.message
      : "quote fetch failed";
  return NextResponse.json({ symbol, error: message }, { status: 502 });
}
