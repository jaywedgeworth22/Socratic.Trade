export const DEFAULT_REQUEST_USER_ID = "local";
export const REQUEST_USER_ID_HEADER = "x-user-id";
export const REQUEST_USER_ID_QUERY_PARAM = "userId";

interface RequestUserBody {
  userId?: unknown;
}

export function resolveRequestUserId(request: Request, body?: RequestUserBody): string {
  return (
    normalizeUserId(request.headers.get(REQUEST_USER_ID_HEADER)) ??
    normalizeUserId(new URL(request.url).searchParams.get(REQUEST_USER_ID_QUERY_PARAM)) ??
    normalizeUserId(body?.userId) ??
    DEFAULT_REQUEST_USER_ID
  );
}

function normalizeUserId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
