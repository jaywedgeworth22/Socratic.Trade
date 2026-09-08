/**
 * Shared classifiers for transport-layer failures.
 *
 * Two different things get labeled "the network died" in this codebase and they
 * must not be treated the same:
 *
 * - A **caller abort / budget timeout** (AbortController on `/api/quote`'s 6s
 *   cascade, nasdaq-calendar's 8s per-day fetch) is expected.  Log it soft so
 *   it cannot paint a lane STOPPED or mint a Sentry "connection failed".
 * - A **dead keep-alive socket** (`fetch failed` + `UND_ERR_SOCKET` /
 *   "other side closed") is transient and worth one retry.  It is still a
 *   hard health row if it survives the retry — a real outage must still page
 *   after the consecutive-failure streak.
 */

function errorText(error: unknown): string {
  const parts: unknown[] = [error];
  if (error && typeof error === "object" && "cause" in error) {
    parts.push((error as { cause: unknown }).cause);
  }
  return parts
    .map((part) => {
      if (!part) return "";
      if (part instanceof Error) {
        const code = (part as NodeJS.ErrnoException).code ?? "";
        return `${part.name} ${part.message} ${code}`;
      }
      if (typeof part === "object") {
        const rec = part as { code?: unknown; message?: unknown; name?: unknown };
        return `${rec.name ?? ""} ${rec.message ?? ""} ${rec.code ?? ""} ${String(part)}`;
      }
      return String(part);
    })
    .join(" ");
}

/** Caller cancelled the request (budget, teardown).  Do not retry. */
export function isAbortOrTimeoutError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  return /this operation was aborted|the operation was aborted|\bAbortError\b|\bTimeoutError\b/i.test(
    errorText(error)
  );
}

/**
 * Socket/DNS-layer text shapes, as they appear in a Node/undici error message or on `err.cause`.
 *
 * Single source of truth: the health store classifies an already-stringified `error_text` row and
 * the RAG lane classifies a raw provider message, and the two drifting apart is exactly how
 * `ECONNRESET` ended up paging as a hard outage while the byte-identical `"fetch failed"` did not.
 * Deliberately narrow — every entry is a transport string a provider's own HTTP response body
 * cannot produce, so an `HTTP 500` or an auth rejection stays hard.
 */
const TRANSIENT_NETWORK_TEXT =
  /fetch failed|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|other side closed|socket hang up|network socket disconnected|\bECONNRESET\b|\bECONNREFUSED\b|\bECONNABORTED\b|\bETIMEDOUT\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bEPIPE\b|\bEHOSTUNREACH\b|\bENETUNREACH\b/i;

/** Same classification as `isTransientNetworkError`, for a message that is already a string. */
export function isTransientNetworkErrorText(text: string | null | undefined): boolean {
  return Boolean(text) && TRANSIENT_NETWORK_TEXT.test(String(text));
}

/** Dead socket / DNS / reset — retry once, then count as a hard transport failure. */
export function isTransientNetworkError(error: unknown): boolean {
  if (isAbortOrTimeoutError(error)) return false;
  return TRANSIENT_NETWORK_TEXT.test(errorText(error));
}

export function isCallerSignalAborted(init: { signal?: AbortSignal | null } | undefined): boolean {
  return Boolean(init?.signal?.aborted);
}

/**
 * Methods whose transport failure is safe to replay.  Deliberately the read-only set: a
 * request that never mutates state can be re-sent after a dead socket with no risk that
 * the first attempt actually landed on the far side.  `fetch()` defaults to GET, so an
 * `init` with no method is retryable.
 *
 * PUT/DELETE are idempotent by RFC 9110 and still excluded — nothing on this codebase's
 * health path uses them, and "idempotent by spec" is not the same as "safe to replay
 * against this vendor" for a write.
 */
const REPLAYABLE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True when the request may be replayed after a transport error (read-only method). */
export function isIdempotentRequest(init?: { method?: string | null } | null): boolean {
  const method = String(init?.method ?? "GET").toUpperCase();
  return REPLAYABLE_HTTP_METHODS.has(method);
}

/**
 * Fraction of the nominal delay the jitter may move a retry in either direction.
 *
 * Why jitter at all: every provider lane in this process backs off by the SAME fixed
 * multiple of the same constant, so one shared upstream blip (a DNS hiccup, a load
 * balancer cycling) puts a dozen lanes' retries on the identical millisecond and the
 * retry burst looks exactly like the outage it is trying to ride out.  Spreading the
 * retries over a window de-synchronizes them.
 */
export const TRANSIENT_RETRY_JITTER_RATIO = 0.3;

/**
 * Bounded, jittered backoff for retry attempt `attempt` (0-based).  Linear in the attempt
 * number — the same escalation the fixed backoff always used — then scattered by up to
 * ±`TRANSIENT_RETRY_JITTER_RATIO`.  Never negative, and never longer than
 * `(1 + ratio) x baseMs x (attempt + 1)`, so a caller's timeout budget stays predictable.
 *
 * `random` is injectable so tests can pin the bounds instead of asserting on a range.
 */
export function jitteredBackoffMs(baseMs: number, attempt: number, random: () => number = Math.random): number {
  const nominal = Math.max(0, baseMs) * (Math.max(0, attempt) + 1);
  if (nominal <= 0) return 0;
  const spread = nominal * TRANSIENT_RETRY_JITTER_RATIO;
  return Math.max(0, Math.round(nominal - spread + random() * spread * 2));
}
