function jsonResponse(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: false, ...body }), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

export function rateLimitedOperationResponse(
  operation: string,
  retryAfterSeconds: number,
  error: string = `Rate limit exceeded for operation "${operation}". Please retry shortly.`
): Response {
  const retry = Number.isFinite(retryAfterSeconds) ? Math.max(1, Math.ceil(retryAfterSeconds)) : 1;
  return jsonResponse(
    429,
    { code: "rate_limited", operation, retryAfterSeconds: retry, error },
    { "retry-after": String(retry) }
  );
}

export function operationInFlightResponse(
  operation: string,
  activeOperation: string,
  error: string = `Operation "${operation}" conflicts with "${activeOperation}", which is already running.`,
  extra: Record<string, unknown> = {}
): Response {
  return jsonResponse(409, {
    code: "operation_in_flight",
    operation,
    activeOperation,
    error,
    ...extra
  });
}
