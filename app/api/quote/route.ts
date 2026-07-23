import { NextResponse } from "next/server";
import { getEnrichmentProvider, type SymbolEnrichment } from "@/lib/data-providers";
import { resolveRequestUser } from "@/lib/request-user";
import { enforceRateLimit } from "@/lib/rate-limit";
import { runQuoteEnrichmentSingleFlight } from "@/lib/quote-singleflight";
import { fetchYahooFinanceQuote, type YahooFinanceQuote } from "@/lib/yahoo-finance";

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
const CASCADE_BUDGET_MS = 6_000;

type EnrichmentOutcome =
  | { status: "ready"; data: SymbolEnrichment }
  | { status: "failed"; error: unknown };
type BudgetedOutcome = EnrichmentOutcome | { status: "timed-out" };

/** The keyless chart quote is the bounded floor for a valid ticker. It supplies
 * current identity/price/volume while the richer provider cascade runs through
 * its normal caches, quota accounting, and field arbitration. Synthetic chart
 * bid/ask values are deliberately omitted: they are not real quoted spreads. */
function fastQuoteEnrichment(quote: YahooFinanceQuote | undefined): SymbolEnrichment {
  if (!quote) return {};
  const intradayChangePct =
    quote.prevClose > 0
      ? Math.round(((quote.price - quote.prevClose) / quote.prevClose) * 10_000) / 100
      : undefined;
  return {
    ...(quote.companyName ? { companyName: quote.companyName } : {}),
    price: quote.price,
    ...(quote.volume > 0 ? { volume: quote.volume } : {}),
    ...(intradayChangePct !== undefined ? { intradayChangePct } : {}),
    ...(quote.asOf ? { asOf: quote.asOf } : {}),
    sources: {
      ...(quote.companyName ? { companyName: "yahoo-finance" } : {}),
      price: "yahoo-finance",
      ...(quote.volume > 0 ? { volume: "yahoo-finance" } : {}),
      ...(intradayChangePct !== undefined ? { intradayChangePct: "yahoo-finance" } : {}),
      ...(quote.asOf ? { asOf: "yahoo-finance" } : {})
    }
  };
}

/** Rich fundamentals fill holes, while the freshest timestamped price family wins. */
function mergeOnDemandEnrichment(
  fast: SymbolEnrichment,
  rich: SymbolEnrichment
): SymbolEnrichment {
  // Provider records generally omit missing fields, but tolerate an explicit
  // `undefined` without letting it erase a valid fast-floor value.
  const definedRich = Object.fromEntries(
    Object.entries(rich).filter(([key, value]) => key !== "sources" && value !== undefined)
  ) as SymbolEnrichment;
  const fastAsOf = Date.parse(fast.asOf ?? "");
  const richAsOf = Date.parse(rich.asOf ?? "");
  const useRichCurrent = rich.price !== undefined
    && (fast.price === undefined || (Number.isFinite(richAsOf) && (!Number.isFinite(fastAsOf) || richAsOf >= fastAsOf)));
  const current = useRichCurrent ? rich : fast;
  const currentFields = {
    ...(current.price !== undefined ? { price: current.price } : {}),
    ...(current.volume !== undefined ? { volume: current.volume } : {}),
    ...(current.intradayChangePct !== undefined ? { intradayChangePct: current.intradayChangePct } : {}),
    ...(current.asOf !== undefined ? { asOf: current.asOf } : {})
  };
  const currentSources = Object.fromEntries(
    ["price", "volume", "intradayChangePct", "asOf"]
      .filter((field) => current.sources?.[field as keyof typeof current.sources] !== undefined)
      .map((field) => [field, current.sources?.[field as keyof typeof current.sources]])
  ) as SymbolEnrichment["sources"];
  return {
    ...fast,
    ...definedRich,
    ...currentFields,
    sources: { ...fast.sources, ...rich.sources, ...currentSources }
  };
}

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

  // Start both reads together. The rich path remains the canonical provider cascade
  // (including its caches, request quotas, circuit breaker, and provenance). The
  // keyless single-quote path is a bounded identity/quote floor, so one slow optional
  // provider can no longer turn a valid ticker into a chart-only drawer.
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

  const [fast, rich] = await Promise.all([
    fastPromise,
    withinBudget(richPromise, CASCADE_BUDGET_MS)
  ]);
  const fastData = fast.status === "ready" ? fast.data : {};
  const richData = rich.status === "ready" ? rich.data : {};
  const enrichment = mergeOnDemandEnrichment(fastData, richData);

  if (fast.status === "ready" || rich.status === "ready") {
    return NextResponse.json({ symbol, ...enrichment });
  }

  const error = rich.status === "failed" ? rich.error : fast.error;
  const message = rich.status === "timed-out"
    ? "quote fetch timed out"
    : error instanceof Error
      ? error.message
      : "quote fetch failed";
  return NextResponse.json({ symbol, error: message }, { status: 502 });
}
