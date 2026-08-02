import { resolveApiKeyWithSource, type ApiKeySource } from "./db";
import { apiCircuitBreakerShouldSkip } from "./api-circuit-breaker";
import { logApiHealth } from "./db-health";
import { expiresAtRespectingMarketClose } from "./market-hours";
import { BROWSER_UA } from "./web-sources/http";

// Minimal Yahoo Finance chart shape — only the fields we read.
interface VixYahooResponse {
  chart?: { result?: Array<{ indicators?: { quote?: Array<{ close?: (number | null)[] }> } }> };
}

export interface MacroData {
  fedFundsRate: string;
  dgs3moTreasury: string;
  dgs2Treasury: string;
  dgs10Treasury: string;
  inflationExpectation10y: string; // 10Y breakeven — market-implied inflation
  cpiInflation: string;
  corePCE: string; // Fed's preferred inflation gauge (core PCE YoY)
  realGDPGrowth: string; // real GDP, annualized % (SAAR)
  unemploymentRate: string;
  initialClaims: string; // weekly initial jobless claims (labor-market pulse)
  m2MoneySupply: string;
  m2GrowthYoY: string;
  hyCreditSpread: string; // ICE BofA US high-yield OAS — credit risk appetite
  usdIndex: string; // broad trade-weighted USD index
  wtiOil: string; // WTI crude spot
  housingStarts: string;
  consumerSentiment: string;
  vix: string;
  vix3m: string; // 3-month VIX (for term structure)
  asOf: string;
  /**
   * Sourcing flag for the FRED suite (dashboard-only; excluded from the LLM prompt by pruneMacro):
   * true  = a keyed FRED fetch ran this session and the present fields are real. Any series that
   *         failed is blanked to "" (never a fabricated value), so a partial fetch never renders
   *         one — the console shows those specific tiles as "—";
   * false = no FRED fetch happened — every FRED field is blanked to "". `vix` is a live reading
   *         iff `asOf` is a real date (the keyless ^VIX cascade succeeded);
   *         `asOf === "unavailable"` means even the VIX is blank.
   * undefined = payload from an older build; callers should fall back to the asOf heuristic.
   */
  fredSourced?: boolean;
}

/**
 * Every data field blanked to "" — the same partial-fetch convention the console renders as an em
 * dash and pruneMacro now drops from the strategy prompt. This replaced the old DEFAULT_MACRO
 * placeholder constants: fabricated readings (a hardcoded inverted yield curve, a fake VIX) must
 * never reach determineMarketRegime, deriveMacroMetrics, or the strategist as if they were data.
 */
const BLANK_MACRO: MacroData = {
  fedFundsRate: "",
  dgs3moTreasury: "",
  dgs2Treasury: "",
  dgs10Treasury: "",
  inflationExpectation10y: "",
  cpiInflation: "",
  corePCE: "",
  realGDPGrowth: "",
  unemploymentRate: "",
  initialClaims: "",
  m2MoneySupply: "",
  m2GrowthYoY: "",
  hyCreditSpread: "",
  usdIndex: "",
  wtiOil: "",
  housingStarts: "",
  consumerSentiment: "",
  vix: "",
  vix3m: "",
  asOf: "unavailable",
  fredSourced: false
};

// ── Cache-provenance scoping (mirrors src/lib/history.ts) ─────────────────────
// FRED macro data is fetched with whichever API key the calling user has
// configured. A user-keyed fetch must NOT silently populate the global shared
// cache and be served to every other user for 24h — that cross-user data leak
// is the bug this scoping fixes.
//
// Allowed-to-share providers (env/free keys whose data is freely redistributable):
//   - FRED keys stored as env vars (source === "env") are operator keys meant for
//     all users — sharing is correct.
//   - No unauthenticated FRED tier exists; without any key, we return defaults.
//
// User-keyed FRED results are kept private unless MARKET_DATA_SHARE_USER_KEYED_MACRO
// is explicitly set to "1"/"true"/"yes"/"on" (owner-controlled opt-in, default OFF).
//
// Safe default: unknown/ambiguous provenance → private (never shared).

type MacroCacheScope = "shared" | "private";

interface MacroCacheEntry { expiresAt: number; data: MacroData }

// Two separate caches: one for data from env/operator keys (shared across all
// users), one Map for per-user private entries (user-keyed, not shared).
const sharedMacroCache: { entry: MacroCacheEntry | null } = { entry: null };
const privateMacroCache = new Map<string, MacroCacheEntry>();

function macroCacheScopeForKeySource(source: ApiKeySource): MacroCacheScope {
  if (source === "env") return "shared";   // operator key — safe to share
  if (source === "user") {
    // User's own stored FRED key: private by default; shared only when the
    // opt-in flag is set.  Treat "none" (no key) as shared so the "unavailable"
    // default result is also globally shared (it carries no licensed data).
    return shareUserKeyedMacro() ? "shared" : "private";
  }
  // source === "none": no key at all — the BLANK_MACRO payload with
  // asOf="unavailable" is public and safe to share globally.
  return "shared";
}

function shareUserKeyedMacro(): boolean {
  const value = (process.env.MARKET_DATA_SHARE_USER_KEYED_MACRO ?? "off").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function readMacroCache(scope: MacroCacheScope, userId: string | undefined, now: number): MacroData | null {
  if (scope === "private") {
    const key = `user:${userId ?? "local"}`;
    const entry = privateMacroCache.get(key);
    if (entry && entry.expiresAt > now) return entry.data;
    // Fall through to shared as a secondary read: if the user previously
    // triggered a shared (env-key) fetch, serve it rather than re-fetching.
  }
  const shared = sharedMacroCache.entry;
  if (shared && shared.expiresAt > now) return shared.data;
  return null;
}

function writeMacroCache(scope: MacroCacheScope, userId: string | undefined, data: MacroData, expiresAt: number): void {
  if (scope === "shared") {
    sharedMacroCache.entry = { expiresAt, data };
  } else {
    privateMacroCache.set(`user:${userId ?? "local"}`, { expiresAt, data });
  }
}

const CACHE_TTL_MS = 24 * 60 * 60_000; // Macro data moves slowly; cache 24h

export async function fetchMacroData(userId?: string): Promise<MacroData> {
  const now = Date.now();
  const { source } = resolveApiKeyWithSource("fred", userId);
  const scope = macroCacheScopeForKeySource(source);

  const cached = readMacroCache(scope, userId, now);
  if (cached) return cached;

  const apiKey = resolveApiKeyWithSource("fred", userId).key;
  if (!apiKey) {
    // No FRED key for the full FRED suite — take the key-free fallback path.
    return fetchVixOnlyFallback(scope, userId, now);
  }

  try {
    const [
      fedFunds, dgs3mo, dgs2, dgs10, breakeven10y, cpi, corePce, realGdp, unemployment,
      claims, m2, m2Growth, hySpread, usd, oil, houst, umcsent, vix, vix3m
    ] = await Promise.all([
      fetchFredSeries("FEDFUNDS", apiKey),
      fetchFredSeries("DGS3MO", apiKey),
      fetchFredSeries("DGS2", apiKey),
      fetchFredSeries("DGS10", apiKey),
      fetchFredSeries("T10YIE", apiKey), // 10Y breakeven inflation (market-implied)
      // CPIAUCSL is an index level; `units=pc1` asks FRED for the year-over-year % change
      // so cpiInflation is a true inflation rate (not a ~310 index value rendered as "%").
      fetchFredSeries("CPIAUCSL", apiKey, "pc1"),
      fetchFredSeries("PCEPILFE", apiKey, "pc1"), // core PCE YoY (Fed's preferred gauge)
      fetchFredSeries("A191RL1Q225SBEA", apiKey), // real GDP, % change SAAR (already a rate)
      fetchFredSeries("UNRATE", apiKey),
      fetchFredSeries("ICSA", apiKey), // initial jobless claims (level)
      fetchFredSeries("M2SL", apiKey),
      // M2 money-supply YoY growth (liquidity) — `pc1` gives the year-over-year % change.
      fetchFredSeries("M2SL", apiKey, "pc1"),
      fetchFredSeries("BAMLH0A0HYM2", apiKey), // ICE BofA US high-yield OAS (%)
      fetchFredSeries("DTWEXBGS", apiKey), // broad trade-weighted USD index
      fetchFredSeries("DCOILWTICO", apiKey), // WTI crude spot ($)
      fetchFredSeries("HOUST", apiKey),
      fetchFredSeries("UMCSENT", apiKey),
      fetchFredSeries("VIXCLS", apiKey),
      fetchFredSeries("VXVCLS", apiKey) // 3-month VIX (term structure)
    ]);

    // Sourcing is derived from the DATA, not from key presence: an invalid /
    // rate-limited / erroring key makes every fetchFredSeries return undefined,
    // which would otherwise build an all-placeholder payload that looked
    // sourced (and the 24h cache would pin that lie). Zero real series =>
    // exactly the no-key path (try live VIX, else "unavailable"), and the
    // honest flag is what gets cached.
    const anyFredValue = [
      fedFunds, dgs3mo, dgs2, dgs10, breakeven10y, cpi, corePce, realGdp, unemployment,
      claims, m2, m2Growth, hySpread, usd, oil, houst, umcsent, vix, vix3m
    ].some((value) => Boolean(value));
    if (!anyFredValue) {
      console.error("[macro] FRED key configured but every series fetch failed — treating as unsourced");
      return fetchVixOnlyFallback(scope, userId, now);
    }

    // PARTIAL FRED fetch: some series returned, some failed. Each field that has no real value is
    // blanked to "" — NOT a DEFAULT_MACRO placeholder — so a single failed series can never render as
    // a fabricated live reading. `fredSourced` stays true (a real keyed fetch DID run and the present
    // fields are real); the console blanks each empty field per-tile (its mv/mn helpers treat "" as
    // missing → EM_DASH), so no fredSourced-gated tile shows a placeholder. This closes the "partial
    // payload flagged fully sourced" gap without discarding the series that did resolve.
    const data: MacroData = {
      fedFundsRate: fedFunds ? `${Number(fedFunds).toFixed(2)}%` : "",
      dgs3moTreasury: dgs3mo ? `${Number(dgs3mo).toFixed(2)}%` : "",
      dgs2Treasury: dgs2 ? `${Number(dgs2).toFixed(2)}%` : "",
      dgs10Treasury: dgs10 ? `${Number(dgs10).toFixed(2)}%` : "",
      inflationExpectation10y: breakeven10y ? `${Number(breakeven10y).toFixed(2)}%` : "",
      cpiInflation: cpi ? `${Number(cpi).toFixed(2)}%` : "",
      corePCE: corePce ? `${Number(corePce).toFixed(2)}%` : "",
      realGDPGrowth: realGdp ? `${Number(realGdp).toFixed(2)}%` : "",
      unemploymentRate: unemployment ? `${Number(unemployment).toFixed(2)}%` : "",
      initialClaims: claims ? `${Math.round(Number(claims) / 1000)}K` : "",
      m2MoneySupply: m2 ? `${(Number(m2) / 1000).toFixed(2)}T` : "",
      m2GrowthYoY: m2Growth ? `${Number(m2Growth).toFixed(2)}%` : "",
      hyCreditSpread: hySpread ? `${Number(hySpread).toFixed(2)}%` : "",
      usdIndex: usd ? `${Number(usd).toFixed(2)}` : "",
      wtiOil: oil ? `$${Number(oil).toFixed(2)}` : "",
      housingStarts: houst ? `${(Number(houst) / 1000).toFixed(2)}M` : "",
      consumerSentiment: umcsent ? `${Number(umcsent).toFixed(1)}` : "",
      vix: vix ? `${Number(vix).toFixed(2)}` : "",
      vix3m: vix3m ? `${Number(vix3m).toFixed(2)}` : "",
      asOf: new Date().toISOString().split("T")[0],
      fredSourced: true
    };

    writeMacroCache(scope, userId, data, expiresAtRespectingMarketClose(new Date(now), CACHE_TTL_MS));
    return data;
  } catch (error) {
    console.error("[macro] failed to fetch macroeconomic data:", error);
    // Fetch failed — same as unsourced: every field blank ("" / asOf "unavailable") so the regime
    // classifier stays Unknown and no placeholder string ever reaches the prompt or a metric.
    return { ...BLANK_MACRO };
  }
}

/**
 * Fallback for "no usable FRED data" (no key, or a configured key whose every series fetch failed).
 * Tries to at least fetch a live ^VIX from the keyless cascade (Yahoo -> Cboe) so the
 * regime classifier gets a real volatility reading instead of staying "Unknown"; every FRED field is blanked to "" (the
 * partial-fetch convention — em dash on the console, dropped from the prompt by pruneMacro) and
 * `fredSourced` is false either way. Blank, not placeholder: the old DEFAULT_MACRO constants
 * carried a fabricated inverted curve that distorted determineMarketRegime and fed the strategist
 * placeholder metrics via deriveMacroMetrics.
 *
 * Cached under the CALLER's scope (not hardcoded "shared"): a configured per-USER key that failed
 * must write only that user's PRIVATE entry. Hardcoding "shared" here poisoned the global cache —
 * another user, or the env/operator-key path, would then read this VIX-only/unavailable payload for
 * up to 24h before ever attempting its own valid FRED fetch. The no-key path (source "none") and the
 * env-key path resolve to "shared" via macroCacheScopeForKeySource, so their behavior is unchanged.
 */
async function fetchVixOnlyFallback(scope: MacroCacheScope, userId: string | undefined, now: number): Promise<MacroData> {
  const liveVix = await fetchKeylessVix();
  if (liveVix !== null) {
    const lightMacro: MacroData = {
      ...BLANK_MACRO,
      vix: liveVix.toFixed(2),
      asOf: new Date().toISOString().split("T")[0],
      fredSourced: false // only the VIX is live; every FRED field is blank
    };
    writeMacroCache(scope, userId, lightMacro, expiresAtRespectingMarketClose(new Date(now), CACHE_TTL_MS));
    return lightMacro;
  }
  // VIX fetch also failed — everything blank ("unavailable") so the regime stays Unknown.
  const fallback = { ...BLANK_MACRO };
  writeMacroCache(scope, userId, fallback, expiresAtRespectingMarketClose(new Date(now), CACHE_TTL_MS));
  return fallback;
}

/** Clear both caches (test helper). */
export function clearMacroCacheForTests(): void {
  sharedMacroCache.entry = null;
  privateMacroCache.clear();
  liveVixCache.entry = null;
}

// ── Keyless ^VIX cascade ──────────────────────────────────────────────────────
// VIX is the regime classifier's primary axis and the vol panic brake's main gauge, so it must not
// hinge on a single free endpoint: Yahoo's chart API is intermittently rate-limited/bot-challenged
// from datacenter IPs (the driver of the 2026-07-28 prod regime flap). Note FMP is deliberately NOT
// in this chain — the macro/VIX path never called it (the suspended FMP key only affected the
// enrichment cascade), and a suspended paid key must not be hammered on every scheduler tick anyway.
//
// Lane order (first success wins):
//   1. Cboe _VIX delayed — the authoritative VIX publisher's own keyless delayed-quote CDN (same
//      host family already trusted for _SKEW/_VVIX in market-signals/cboe.ts).
//   2. Yahoo ^VIX chart  — secondary fallback (intermittently rate-limited/blocked from datacenter IPs).
//
// This is deliberately a TWO-lane cascade. The third-tier candidates were live-probed and rejected
// (2026-07-29 verifier review): Stooq's quote endpoint (stooq.com/q/l/) 404s endpoint-level and its
// daily CSV lane (q/d/l/, used by history.ts for equities) sits behind a JS anti-bot interstitial;
// Nasdaq's keyless index quote API (api.nasdaq.com/api/quote/{sym}/info?assetclass=index, proven
// in-repo for NDX) does not carry VIX (a CBOE product — "Symbol not exists"); Yahoo's v7 quote
// endpoint requires crumb auth and shares Yahoo's failure domain anyway. A dead tier would only
// emit phantom provider_degraded alerts during real double-outages, so honesty beats lane count.
//
// Every lane runs through the repo's shared per-lane circuit breaker (api-circuit-breaker.ts) with
// failures/successes recorded in api_health_log: a lane whose recent history reads "stopped
// working" (getLaneHealth: 5 consecutive failures, or active-this-hour with no success) trips for
// API_CIRCUIT_BREAKER_BACKOFF_MS (default 60s), then ONE half-open probe is allowed — a dead
// endpoint is retried on a probe cadence, not hammered every tick. ALL sources dead -> null, and
// the caller's honest "unavailable" path (never a fabricated reading).

/** One keyless VIX fetch through the circuit-breaker + health-log machinery. Null on any failure. */
async function fetchVixLane(
  lane: string,
  url: string,
  accept: string,
  parse: (res: Response) => Promise<number | null>
): Promise<number | null> {
  const breaker = apiCircuitBreakerShouldSkip(lane, null);
  if (breaker.skip) return null; // lane backed off — try the next source
  const start = Date.now();
  const log = (ok: boolean, errorText?: string) =>
    // keySource omitted -> stored as NULL, matching the breaker's (lane, null) keyless lane.
    logApiHealth({ service: lane, ok, latencyMs: Date.now() - start, errorText });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { "user-agent": BROWSER_UA, accept }
    });
    if (!res.ok) {
      log(false, `HTTP ${res.status}`);
      return null;
    }
    const value = await parse(res);
    // A 200 with no usable VIX value still counts against the lane's health: from this module's
    // perspective the endpoint is not serving the reading we need.
    log(value !== null, value === null ? "no usable VIX value in response" : undefined);
    return value;
  } catch (err) {
    log(false, err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Fetch the latest ^VIX close from Yahoo Finance (no API key required). Returns null on any failure. */
async function fetchVixFromYahoo(): Promise<number | null> {
  return fetchVixLane(
    "vix-yahoo",
    "https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=5d&interval=1d",
    "application/json",
    async (res) => {
      const json = (await res.json()) as VixYahooResponse;
      const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
      // Walk back from the end to find the most recent non-null close.
      for (let i = closes.length - 1; i >= 0; i--) {
        const c = closes[i];
        if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
      }
      return null;
    }
  );
}

/** Cboe delayed _VIX quote from the publisher's own keyless CDN. Returns null on any failure. */
async function fetchVixFromCboe(): Promise<number | null> {
  return fetchVixLane(
    "vix-cboe",
    "https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json",
    "application/json",
    async (res) => {
      const json = (await res.json()) as { data?: { current_price?: unknown } };
      const px = json?.data?.current_price;
      return typeof px === "number" && Number.isFinite(px) && px > 0 ? Math.round(px * 100) / 100 : null;
    }
  );
}

/** First successful keyless VIX reading across the cascade; null when every source is down. */
async function fetchKeylessVix(): Promise<number | null> {
  for (const source of [fetchVixFromCboe, fetchVixFromYahoo]) {
    const vix = await source();
    if (vix !== null) return vix;
  }
  return null;
}

// ── Live ^VIX overlay (short TTL, independent of the 24h macro cache) ────────────────────────
// `fetchMacroData` is cached 24h — appropriate for the slow-moving FRED suite (rates, inflation,
// GDP), but VIX can move double digits intraday, so pinning it to the same day-old snapshot means
// the volatility panic brake and the regime-flip detector could be up to a day blind on a crash
// day (composite review D/high/S). This is a SEPARATE cache entry with a short TTL, keyed off the
// same keyless ^VIX cascade (`fetchKeylessVix`: Yahoo -> Cboe) the no-FRED fallback path
// already uses — so no new upstream dependency, just a much shorter TTL and its own cache slot. Callers that
// need the freshest possible volatility read (the vol brake, regime-flip detection) should use
// `fetchLiveVix`/`fetchMacroDataWithLiveVix` instead of trusting the 24h `fetchMacroData` snapshot.

const LIVE_VIX_TTL_MS = 10 * 60_000; // 10 min — short enough to catch an intraday vol spike

interface LiveVixEntry { expiresAt: number; vix: number | null; asOf: string }
const liveVixCache: { entry: LiveVixEntry | null } = { entry: null };

/**
 * Live ^VIX reading with a short (10 min) TTL, independent of the 24h macro cache. Global/shared —
 * every endpoint in the keyless cascade is key-free and carries no per-user licensing concern (same
 * provenance reasoning as the no-FRED-key VIX fallback in fetchMacroData). Returns `vix: null` when
 * the live fetch fails (never fabricates a reading); `asOf` is only a real ISO timestamp when the
 * fetch actually succeeded this call or a still-fresh cache entry is served.
 */
export async function fetchLiveVix(now: number = Date.now()): Promise<{ vix: number | null; asOf: string | null }> {
  const cached = liveVixCache.entry;
  if (cached && cached.expiresAt > now) return { vix: cached.vix, asOf: cached.vix !== null ? cached.asOf : null };

  const vix = await fetchKeylessVix();
  const asOf = new Date(now).toISOString();
  liveVixCache.entry = { expiresAt: now + LIVE_VIX_TTL_MS, vix, asOf };
  return { vix, asOf: vix !== null ? asOf : null };
}

/**
 * Overlay a live (short-TTL) VIX reading onto the (possibly 24h-stale) cached macro snapshot.
 * Everything else — rates, inflation, credit spreads, etc. — still comes from the slow-moving FRED
 * suite via `fetchMacroData`; only `vix` and `asOf` are refreshed from the live path, and only when
 * the live fetch actually succeeds (a transient Yahoo failure falls back to the cached VIX rather
 * than blanking a previously-good reading). Use this instead of bare `fetchMacroData` wherever a
 * stale VIX would matter: the volatility panic brake and the regime-flip detector.
 */
export async function fetchMacroDataWithLiveVix(userId?: string): Promise<MacroData & { vixAsOf?: string }> {
  const [macro, live] = await Promise.all([fetchMacroData(userId), fetchLiveVix()]);
  if (live.vix === null || live.asOf === null) return macro;
  return {
    ...macro,
    vix: live.vix.toFixed(2),
    // A live VIX overlay always counts as a live snapshot for the regime classifier, even when the
    // rest of the FRED suite is unavailable — asOf "unavailable" would otherwise force the
    // classifier's early-return Unknown branch despite a real, fresh VIX reading in hand.
    asOf: macro.asOf === "unavailable" ? live.asOf : macro.asOf,
    vixAsOf: live.asOf
  };
}

// Regime-critical fields that are always worth the tokens even when unchanged.
const MACRO_ALWAYS_KEEP = new Set<keyof MacroData>(["vix", "fedFundsRate", "dgs10Treasury", "asOf"]);

/**
 * Delta-only macro pruning: macro data moves slowly, so on repeat runs only send
 * the fields that changed since the last run (plus a few regime-critical ones),
 * and list the rest as "unchanged" instead of re-spending tokens on them.
 */
export function pruneMacro(
  current: MacroData,
  previous?: MacroData | null
): { macro: Record<string, string>; omitted: string[] } {
  // Only the string data fields go to the LLM. Meta/sourcing flags (fredSourced) are
  // dashboard-only, and empty-string fields (an unsourced/failed series — the value the console
  // renders as an em dash) are dropped entirely: the strategist must never see a blank or
  // placeholder reading presented as data.
  const entries = (Object.entries(current) as Array<[keyof MacroData, MacroData[keyof MacroData]]>).filter(
    (entry): entry is [keyof MacroData, string] => typeof entry[1] === "string" && entry[1] !== ""
  );
  if (!previous) return { macro: Object.fromEntries(entries), omitted: [] };
  const macro: Record<string, string> = {};
  const omitted: string[] = [];
  for (const [key, value] of entries) {
    if (MACRO_ALWAYS_KEEP.has(key) || previous[key] !== value) {
      macro[key] = value;
    } else {
      omitted.push(key);
    }
  }
  return { macro, omitted };
}

// Typed regime enum + numeric severity + the classifier/gate helpers now live in the
// dependency-free ./market-regime module so client-bundled code (e.g. the console Macro board)
// can import the enum helpers by value without pulling in server-only modules (this file imports
// ./db). Re-exported here so existing `import { X } from "./macro"` call sites are unaffected.
export {
  classifyMarketRegime,
  isCrisisOrInvertedMarketRegime,
  isEscalationMarketRegime,
  isRiskOffFilterRegime,
  MARKET_REGIME_LABELS,
  MARKET_REGIME_SEVERITY,
  regimeFromLabel,
  type MarketRegime
} from "./market-regime";
import { classifyMarketRegime, MARKET_REGIME_LABELS } from "./market-regime";

/**
 * Deterministic market-regime classifier. Primary axis is VIX (volatility), but the
 * yield curve (10y vs Fed funds) actually participates now: an inverted curve — a
 * classic recession/risk signal — nudges borderline VIX readings toward risk-off and
 * surfaces a distinct "Cautious (Inverted Curve)" regime in calm-but-inverted markets.
 * Kept to a small, repeatable label set so the thesis×regime learning buckets stay
 * dense enough to learn from. Richer macro detail still reaches the LLM via the prompt.
 *
 * Returns the byte-identical label strings this function has always returned — persisted
 * verbatim as `entryMarketRegime` — by projecting `classifyMarketRegime`'s enum (./market-regime)
 * through `MARKET_REGIME_LABELS`. New code should prefer `classifyMarketRegime` (enum + severity)
 * over string-matching this label.
 */
export function determineMarketRegime(macro: MacroData): string {
  return MARKET_REGIME_LABELS[classifyMarketRegime(macro).regime];
}

/** Tail-risk gauges the volatility panic brake reads (beyond VIX, which lives on MacroData). */
export interface VolBrakeSignals {
  vvix?: number;
  skew?: number;
}

export interface VolBrakePolicy {
  volPanicBrakeEnabled?: boolean;
  volPanicVixThreshold?: number;
  volPanicVvixThreshold?: number;
  volPanicSkewThreshold?: number;
}

const VOL_BRAKE_DEFAULTS = { vix: 40, vvix: 150, skew: 160 } as const;

/**
 * Deterministic volatility panic brake. Returns brake=true when ANY configured tail-risk gauge
 * (VIX from macro, Cboe VVIX/SKEW from market signals) is at/above its threshold. Pure + side-effect
 * free so the caller decides whether to flip systemState. Disabled when volPanicBrakeEnabled === false.
 * A missing gauge is simply skipped (never fabricated), so partial data can never false-trip the brake.
 */
export function evaluateVolatilityBrake(
  macro: MacroData | undefined,
  signals: VolBrakeSignals | undefined,
  policy: VolBrakePolicy
): { brake: boolean; reason?: string } {
  if (policy.volPanicBrakeEnabled === false) return { brake: false };
  const vixThreshold = policy.volPanicVixThreshold ?? VOL_BRAKE_DEFAULTS.vix;
  const vvixThreshold = policy.volPanicVvixThreshold ?? VOL_BRAKE_DEFAULTS.vvix;
  const skewThreshold = policy.volPanicSkewThreshold ?? VOL_BRAKE_DEFAULTS.skew;

  const vix = macro && macro.asOf !== "unavailable" ? parseFloat(macro.vix) : NaN;
  const tripped: string[] = [];
  if (Number.isFinite(vix) && vixThreshold > 0 && vix >= vixThreshold) {
    tripped.push(`VIX ${vix.toFixed(1)} ≥ ${vixThreshold}`);
  }
  if (typeof signals?.vvix === "number" && Number.isFinite(signals.vvix) && vvixThreshold > 0 && signals.vvix >= vvixThreshold) {
    tripped.push(`VVIX ${signals.vvix.toFixed(1)} ≥ ${vvixThreshold}`);
  }
  if (typeof signals?.skew === "number" && Number.isFinite(signals.skew) && skewThreshold > 0 && signals.skew >= skewThreshold) {
    tripped.push(`SKEW ${signals.skew.toFixed(1)} ≥ ${skewThreshold}`);
  }
  if (tripped.length === 0) return { brake: false };
  return { brake: true, reason: `Volatility panic brake: ${tripped.join("; ")} — halting new entries (close_only).` };
}

async function fetchFredSeries(seriesId: string, apiKey: string, units?: string): Promise<string | undefined> {
  const unitsParam = units ? `&units=${units}` : "";
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&limit=1&sort_order=desc${unitsParam}&api_key=${apiKey}&file_type=json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return undefined;
    const payload = await response.json() as any;
    const value = payload?.observations?.[0]?.value;
    return value && value !== "." ? String(value) : undefined;
  } catch {
    clearTimeout(timeout);
    return undefined;
  }
}
