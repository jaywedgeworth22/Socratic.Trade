import { NextRequest, NextResponse } from "next/server";
import { apiKeyEnvVarForService, listUserApiKeys, LOCAL_USER, maskApiKeyPreview, normalizeApiKeyService, upsertUserApiKey, deleteUserApiKey, resolveApiKeyWithSource } from "@/lib/db";
import { checkAdmin } from "@/lib/auth/admin";
import { resolveRequestUserId } from "@/lib/request-user";
import { queueStPrimaryBridgeWriterSync } from "@/lib/st-primary-bridge-writer";

export const dynamic = "force-dynamic";

/**
 * Multi-user API Key Management
 *
 * Per-user API key storage. Identity comes from middleware's verified
 * `x-authenticated-user-email` header; request body/query user hints are ignored.
 *
 * Supported services are defined in API_KEY_CATALOG below.
 *
 * GET  /api/keys             → list all keys for the current user
 * GET  /api/keys?service=<s> → resolve key (user → env fallback)
 * POST /api/keys  { service, apiKey, label? }  → upsert key
 * DELETE /api/keys?service=<s>  → delete key
 */

const API_KEY_CATALOG = [
  {
    service: "openai",
    label: "OpenAI",
    category: "LLM",
    required: false,
    unlocks: "OpenAI models for trade proposals, strategy reviews, red-team debate, and post-mortems.",
    docsUrl: "https://platform.openai.com/api-keys"
  },
  {
    service: "anthropic",
    label: "Anthropic (Claude)",
    category: "LLM",
    required: false,
    unlocks: "Claude models for the Assistant chat and for the Green/Red Team (trade proposals, strategy review, red-team debate). Select a claude-* model in Strategy or the Assistant to use.",
    docsUrl: "https://console.anthropic.com/settings/keys"
  },
  {
    service: "xai",
    label: "xAI (Grok)",
    category: "LLM",
    required: false,
    unlocks: "Grok models for trade proposals, strategy analysis, and the Assistant. Select a grok-* model to use.",
    docsUrl: "https://console.x.ai/"
  },
  {
    service: "gemini",
    label: "Google (Gemini)",
    category: "LLM",
    required: false,
    unlocks: "Gemini models for the Assistant and strategy review. Select a gemini-* model in the Assistant or Strategy screen to use.",
    docsUrl: "https://aistudio.google.com/app/apikey"
  },
  {
    service: "mistral",
    label: "Mistral AI",
    category: "LLM",
    required: false,
    unlocks: "Mistral models for the Assistant and strategy review. Select a mistral-* model in the Assistant or Strategy screen to use.",
    docsUrl: "https://console.mistral.ai/api-keys/"
  },
  {
    service: "deepseek",
    label: "DeepSeek",
    category: "LLM",
    required: false,
    unlocks: "DeepSeek V4 models (deepseek-v4-flash / deepseek-v4-pro) for the Assistant and strategy. Note: requests are processed on DeepSeek's servers (China).",
    docsUrl: "https://platform.deepseek.com/api_keys"
  },
  {
    service: "openrouter",
    label: "OpenRouter",
    category: "LLM",
    required: false,
    unlocks: "Access to OpenRouter models including DeepSeek and Qwen for the Assistant and strategy.",
    docsUrl: "https://openrouter.ai/keys"
  },
  {
    service: "finnhub",
    label: "Finnhub",
    category: "Market data",
    required: false,
    unlocks: "News sentiment, analyst recommendations, company profile, and financial metrics.",
    docsUrl: "https://finnhub.io/dashboard"
  },
  {
    service: "fmp",
    label: "Financial Modeling Prep",
    category: "Market data",
    required: false,
    unlocks: "Fundamentals, ratios, analyst grades, and earnings-related enrichment.",
    docsUrl: "https://site.financialmodelingprep.com/developer/docs"
  },
  {
    service: "alphavantage",
    label: "Alpha Vantage",
    category: "Market data",
    required: false,
    unlocks: "Supplemental fundamentals and sentiment where the keyed quota is available.",
    docsUrl: "https://www.alphavantage.co/support/#api-key"
  },
  {
    service: "marketstack",
    label: "Marketstack",
    category: "Price history",
    required: false,
    unlocks: "Reliable daily OHLC fallback for price charts and computed technicals.",
    docsUrl: "https://marketstack.com/signup/free"
  },
  {
    service: "fred",
    label: "FRED",
    category: "Macro",
    required: false,
    unlocks: "Rates, inflation, growth, credit spreads, VIX, and Macro tab sparklines.",
    docsUrl: "https://fred.stlouisfed.org/docs/api/api_key.html"
  },
  {
    service: "sec_edgar_user_agent",
    label: "SEC EDGAR User-Agent",
    category: "Scrapers",
    required: false,
    credentialName: "contact",
    unlocks: "Polite SEC Form 4 and 8-K requests with your descriptive contact string.",
    docsUrl: "https://www.sec.gov/os/accessing-edgar-data"
  },
  {
    service: "massive",
    label: "Massive",
    category: "Market-wide signals",
    required: false,
    unlocks: "Full-market breadth, broad liquid movers, news, and keyed price-history primary data.",
    docsUrl: "https://massive.com"
  }
] as const;

const VALID_SERVICES: ReadonlySet<string> = new Set(API_KEY_CATALOG.map((item) => item.service));
const ST_PRIMARY_BRIDGE_SERVICES: ReadonlySet<string> = new Set(["gemini", "deepseek"]);

function queuePrimaryBridgeAfterTrackedMutation(userId: string, service: string): void {
  if (userId === LOCAL_USER && ST_PRIMARY_BRIDGE_SERVICES.has(service)) {
    queueStPrimaryBridgeWriterSync();
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const userId = resolveRequestUserId(request);
  const service = searchParams.get("service");

  // A key's masked preview (first 8 + last 4, never a usable value) answers "WHICH key is serving
  // me?" — the question the write-only key store otherwise makes unanswerable when several keys
  // exist for one provider. Your OWN stored key is always previewable to you; the operator's env
  // credential is previewable only to an operator/admin, so a tenant riding the shared key can see
  // that one is serving them ("server key") without learning anything about the operator's secret.
  // Token-based admin is excluded on purpose: this is an interactive, identity-bound disclosure.
  const isOperator = checkAdmin(request, { allowToken: false }).ok;
  const previewFor = (resolved: { key?: string; source: string }): string | undefined =>
    resolved.source === "user" || isOperator ? maskApiKeyPreview(resolved.key) : undefined;

  // If a specific service is requested, resolve the key (user DB → env fallback)
  if (service) {
    const canonical = normalizeApiKeyService(service);
    if (!VALID_SERVICES.has(canonical)) {
      return NextResponse.json({ error: `Invalid service. Must be one of: ${[...VALID_SERVICES].join(", ")}` }, { status: 400 });
    }
    const resolved = resolveApiKeyWithSource(canonical, userId);
    return NextResponse.json({
      service: canonical,
      configured: Boolean(resolved.key),
      source: resolved.source,
      envVar: resolved.envVar,
      preview: previewFor(resolved)
      // NOTE: never return the actual key in a GET response for security — `preview` is the
      // elided first-8/last-4 form only (see maskApiKeyPreview).
    });
  }

  // List all keys for the user (mask the actual key values)
  const keys = listUserApiKeys(userId);
  const storedByService = new Map(keys.map((key) => [normalizeApiKeyService(key.service), key]));
  return NextResponse.json({
    keys: API_KEY_CATALOG.map((entry) => {
      const stored = storedByService.get(entry.service);
      const resolved = resolveApiKeyWithSource(entry.service, userId);
      const envVar = apiKeyEnvVarForService(entry.service);
      return {
        ...entry,
        envVar,
        configured: Boolean(resolved.key),
        source: resolved.source,
        preview: previewFor(resolved),
        updatedAt: stored?.updatedAt,
        savedLabel: stored?.label
      };
    })
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { userId?: string; service?: string; apiKey?: string; label?: string };
    const { service, apiKey, label } = body;
    const userId = resolveRequestUserId(request, body);

    const canonical = service ? normalizeApiKeyService(service) : "";
    if (!canonical || !VALID_SERVICES.has(canonical)) {
      return NextResponse.json({ error: `service is required and must be one of: ${[...VALID_SERVICES].join(", ")}` }, { status: 400 });
    }
    if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
      return NextResponse.json({ error: "apiKey is required and must be a non-empty string" }, { status: 400 });
    }

    const result = upsertUserApiKey(userId, canonical, apiKey.trim(), label);
    queuePrimaryBridgeAfterTrackedMutation(userId, canonical);
    return NextResponse.json({
      success: true,
      key: {
        id: result.id,
        service: result.service,
        label: result.label,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt
      }
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save API key" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const userId = resolveRequestUserId(request);
  const service = searchParams.get("service");

  if (!service) {
    return NextResponse.json({ error: "service query parameter is required" }, { status: 400 });
  }

  const canonical = normalizeApiKeyService(service);
  if (!VALID_SERVICES.has(canonical)) {
    return NextResponse.json({ error: `Invalid service. Must be one of: ${[...VALID_SERVICES].join(", ")}` }, { status: 400 });
  }

  const deleted = deleteUserApiKey(userId, canonical);
  queuePrimaryBridgeAfterTrackedMutation(userId, canonical);
  return NextResponse.json({ success: true, deleted });
}
