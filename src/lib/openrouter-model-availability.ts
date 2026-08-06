import { normalizeOpenRouterModelId } from "./llm-provider";

const AVAILABILITY_CACHE_TTL_MS = 5 * 60 * 1_000;
const AVAILABILITY_TIMEOUT_MS = 5_000;

type AvailabilityResult =
  | { status: "available"; modelIds: ReadonlySet<string> }
  | { status: "unavailable"; reason: string }
  | { status: "not_checked" };

type CachedAvailability = { expiresAt: number; modelIds: ReadonlySet<string> };
const availabilityCache = new Map<string, CachedAvailability>();

function modelsUserUrl(): string {
  const configured = process.env.OPENROUTER_MODELS_USER_URL?.trim();
  if (configured) return configured;
  const apiUrl = process.env.OPENROUTER_API_URL?.trim() || "https://openrouter.ai/api/v1/chat/completions";
  if (/\/chat\/completions\/?$/i.test(apiUrl)) return apiUrl.replace(/\/chat\/completions\/?$/i, "/models/user");
  if (/\/v1\/?$/i.test(apiUrl)) return `${apiUrl.replace(/\/$/, "")}/models/user`;
  return "https://openrouter.ai/api/v1/models/user";
}

function abortAfter(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

/**
 * Fetch the account-filtered OpenRouter model list. The endpoint reflects the user's provider
 * preferences/guardrails, which is the relevant distinction from merely having an OpenRouter key.
 * Errors are deliberately returned as unavailable: rotation must not select an unknown model.
 */
export async function getOpenRouterUserModelAvailability(key: string, keyRef?: string): Promise<AvailabilityResult> {
  if (process.env.NODE_ENV === "test") return { status: "not_checked" };
  const cacheKey = keyRef || "anonymous-key";
  const cached = availabilityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { status: "available", modelIds: cached.modelIds };

  const timeout = abortAfter(AVAILABILITY_TIMEOUT_MS);
  try {
    const response = await fetch(modelsUserUrl(), {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: timeout.signal
    });
    if (!response.ok) return { status: "unavailable", reason: `http_${response.status}` };
    const payload = (await response.json().catch(() => undefined)) as { data?: Array<{ id?: unknown }> } | undefined;
    const ids = new Set(
      Array.isArray(payload?.data)
        ? payload.data.filter((model) => typeof model.id === "string").map((model) => normalizeOpenRouterModelId(model.id as string))
        : []
    );
    if (ids.size === 0) return { status: "unavailable", reason: "empty_model_list" };
    availabilityCache.set(cacheKey, { expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_MS, modelIds: ids });
    return { status: "available", modelIds: ids };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof DOMException && error.name === "AbortError" ? "timeout" : "network_error" };
  } finally {
    timeout.cancel();
  }
}

/** Test-only cache reset; production callers have no reason to clear process-local availability. */
export function clearOpenRouterUserModelAvailabilityCache(): void {
  availabilityCache.clear();
}

export function isOpenRouterModelAvailable(model: string, modelIds: ReadonlySet<string>): boolean {
  return modelIds.has(normalizeOpenRouterModelId(model));
}
