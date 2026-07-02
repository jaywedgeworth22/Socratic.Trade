import { resolveApiKeyWithSource, type ApiKeySource } from "./db";
import { BROWSER_UA, politeFetchJson } from "./web-sources/http";

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
   * true  = the full FRED fetch ran with an API key this session (fields are real, modulo
   *         rare per-series fallbacks to DEFAULT_MACRO when one series returns nothing);
   * false = no FRED fetch happened — every field except possibly `vix` is a DEFAULT_MACRO
   *         placeholder constant. `vix` is a live reading iff `asOf` is a real date (the
   *         key-free Yahoo ^VIX fallback succeeded); `asOf === "unavailable"` means even
   *         the VIX is a placeholder.
   * undefined = payload from an older build; callers should fall back to the asOf heuristic.
   */
  fredSourced?: boolean;
}

const DEFAULT_MACRO: MacroData = {
  fedFundsRate: "5.25%",
  dgs3moTreasury: "5.10%",
  dgs2Treasury: "4.60%",
  dgs10Treasury: "4.20%",
  inflationExpectation10y: "2.30%",
  cpiInflation: "3.10%",
  corePCE: "2.80%",
  realGDPGrowth: "2.00%",
  unemploymentRate: "3.90%",
  initialClaims: "220K",
  m2MoneySupply: "20.8T",
  m2GrowthYoY: "2.50%",
  hyCreditSpread: "3.20%",
  usdIndex: "121.00",
  wtiOil: "$75.00",
  housingStarts: "1.3M",
  consumerSentiment: "75.0",
  vix: "15.00",
  vix3m: "17.00",
  asOf: new Date().toISOString().split("T")[0],
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
  // source === "none": no key at all — the DEFAULT_MACRO constant with
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
    // No FRED key for the full FRED suite. Try to at least fetch live ^VIX from Yahoo Finance
    // (key-free) so the regime classifier gets a real volatility reading instead of staying
    // "Unknown". Other macro fields stay at DEFAULT_MACRO approximations — VIX is the primary
    // regime axis anyway (see determineMarketRegime).
    const liveVix = await fetchVixFromYahoo();
    if (liveVix !== null) {
      const lightMacro: MacroData = {
        ...DEFAULT_MACRO,
        vix: liveVix.toFixed(2),
        asOf: new Date().toISOString().split("T")[0],
        fredSourced: false // only the VIX is live; every FRED field is a placeholder constant
      };
      writeMacroCache("shared", userId, lightMacro, now + CACHE_TTL_MS);
      return lightMacro;
    }
    // VIX fetch also failed — fall back to "unavailable" so regime stays Unknown.
    const fallback = { ...DEFAULT_MACRO, asOf: "unavailable", fredSourced: false };
    writeMacroCache("shared", userId, fallback, now + CACHE_TTL_MS);
    return fallback;
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

    const data: MacroData = {
      fedFundsRate: fedFunds ? `${Number(fedFunds).toFixed(2)}%` : DEFAULT_MACRO.fedFundsRate,
      dgs3moTreasury: dgs3mo ? `${Number(dgs3mo).toFixed(2)}%` : DEFAULT_MACRO.dgs3moTreasury,
      dgs2Treasury: dgs2 ? `${Number(dgs2).toFixed(2)}%` : DEFAULT_MACRO.dgs2Treasury,
      dgs10Treasury: dgs10 ? `${Number(dgs10).toFixed(2)}%` : DEFAULT_MACRO.dgs10Treasury,
      inflationExpectation10y: breakeven10y ? `${Number(breakeven10y).toFixed(2)}%` : DEFAULT_MACRO.inflationExpectation10y,
      cpiInflation: cpi ? `${Number(cpi).toFixed(2)}%` : DEFAULT_MACRO.cpiInflation,
      corePCE: corePce ? `${Number(corePce).toFixed(2)}%` : DEFAULT_MACRO.corePCE,
      realGDPGrowth: realGdp ? `${Number(realGdp).toFixed(2)}%` : DEFAULT_MACRO.realGDPGrowth,
      unemploymentRate: unemployment ? `${Number(unemployment).toFixed(2)}%` : DEFAULT_MACRO.unemploymentRate,
      initialClaims: claims ? `${Math.round(Number(claims) / 1000)}K` : DEFAULT_MACRO.initialClaims,
      m2MoneySupply: m2 ? `${(Number(m2) / 1000).toFixed(2)}T` : DEFAULT_MACRO.m2MoneySupply,
      m2GrowthYoY: m2Growth ? `${Number(m2Growth).toFixed(2)}%` : DEFAULT_MACRO.m2GrowthYoY,
      hyCreditSpread: hySpread ? `${Number(hySpread).toFixed(2)}%` : DEFAULT_MACRO.hyCreditSpread,
      usdIndex: usd ? `${Number(usd).toFixed(2)}` : DEFAULT_MACRO.usdIndex,
      wtiOil: oil ? `$${Number(oil).toFixed(2)}` : DEFAULT_MACRO.wtiOil,
      housingStarts: houst ? `${(Number(houst) / 1000).toFixed(2)}M` : DEFAULT_MACRO.housingStarts,
      consumerSentiment: umcsent ? `${Number(umcsent).toFixed(1)}` : DEFAULT_MACRO.consumerSentiment,
      vix: vix ? `${Number(vix).toFixed(2)}` : DEFAULT_MACRO.vix,
      vix3m: vix3m ? `${Number(vix3m).toFixed(2)}` : DEFAULT_MACRO.vix3m,
      asOf: new Date().toISOString().split("T")[0],
      fredSourced: true
    };

    writeMacroCache(scope, userId, data, now + CACHE_TTL_MS);
    return data;
  } catch (error) {
    console.error("[macro] failed to fetch macroeconomic data:", error);
    // Fetch failed — same as unsourced: flag it so the regime classifier stays Unknown.
    return { ...DEFAULT_MACRO, asOf: "unavailable" };
  }
}

/** Clear both caches (test helper). */
export function clearMacroCacheForTests(): void {
  sharedMacroCache.entry = null;
  privateMacroCache.clear();
}

/** Fetch the latest ^VIX close from Yahoo Finance (no API key required). Returns null on any failure. */
async function fetchVixFromYahoo(): Promise<number | null> {
  try {
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=5d&interval=1d";
    const json = await politeFetchJson<VixYahooResponse>(url, {
      headers: { "user-agent": BROWSER_UA, accept: "application/json" }
    });
    const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    // Walk back from the end to find the most recent non-null close.
    for (let i = closes.length - 1; i >= 0; i--) {
      const c = closes[i];
      if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
    }
    return null;
  } catch {
    return null;
  }
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
  // dashboard-only — filtering here keeps the strategy prompt payload byte-identical
  // to what it was before the flag existed.
  const entries = (Object.entries(current) as Array<[keyof MacroData, MacroData[keyof MacroData]]>).filter(
    (entry): entry is [keyof MacroData, string] => typeof entry[1] === "string"
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

/**
 * Deterministic market-regime classifier. Primary axis is VIX (volatility), but the
 * yield curve (10y vs Fed funds) actually participates now: an inverted curve — a
 * classic recession/risk signal — nudges borderline VIX readings toward risk-off and
 * surfaces a distinct "Cautious (Inverted Curve)" regime in calm-but-inverted markets.
 * Kept to a small, repeatable label set so the thesis×regime learning buckets stay
 * dense enough to learn from. Richer macro detail still reaches the LLM via the prompt.
 */
export function determineMarketRegime(macro: MacroData): string {
  // Unsourced macro (no FRED key) carries asOf "unavailable". Don't assert a confident regime off
  // fabricated constants — return an explicit Unknown so downstream conditioning/caps stay neutral.
  if (macro.asOf === "unavailable") return "Unknown (no macro feed)";
  const vix = parseFloat(macro.vix);
  const fedFunds = parseFloat(macro.fedFundsRate);
  const dgs10 = parseFloat(macro.dgs10Treasury);
  // Curve inversion: 10y meaningfully below the policy rate.
  const inverted = Number.isFinite(fedFunds) && Number.isFinite(dgs10) && dgs10 < fedFunds - 0.1;
  if (Number.isFinite(vix)) {
    if (vix > 30) return "Crisis (Extreme Volatility)";
    if (vix > 20 || (inverted && vix > 17)) return "Risk-Off (High Volatility)";
    if (vix < 13 && !inverted) return "Risk-On (Low Volatility)";
  }
  return inverted ? "Cautious (Inverted Curve)" : "Neutral (Normal Volatility)";
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
