// Regression coverage for the three real privacy gaps found in codex-connector
// review of PR #3141 (Sentry Session Replay + trace sampling expansion):
//  1. `sanitizeTelemetryUrl` missed `?apikey=` (no separator) even though that's
//     what this app's actual data providers use (Alpha Vantage/Twelve Data/ROIC,
//     see src/lib/history.ts).
//  2. `beforeSendTransaction` ran the whole event through `redactForTelemetry`,
//     which silently truncates `event.spans` past maxArrayItems (20) into a
//     malformed string marker instead of a real span.
//  3. Session Replay's `beforeAddRecordingEvent` only ever sees rrweb "Custom"
//     events and inspected the wrong field (`data.href`) for URLs, while the
//     replay_event envelope's own `urls` array had no sanitization path at all.
import { describe, expect, it } from "vitest";
import {
  redactTransactionEvent,
  sanitizeReplayEnvelopeEvent,
  sanitizeReplayRecordingEvent,
  sanitizeTelemetryUrl
} from "../src/lib/telemetry-sanitize";

describe("sanitizeTelemetryUrl", () => {
  it("redacts ?apikey= (no separator) -- the shape this app's providers actually use", () => {
    const url = "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=AAPL&apikey=SECRETVALUE123";
    const result = sanitizeTelemetryUrl(url);
    expect(result).not.toContain("SECRETVALUE123");
    expect(result).toContain("apikey=[REDACTED]");
  });

  it("still redacts the previously-supported param names (regression safety net)", () => {
    const url = "/console/orders?symbol=AAPL&proposal=abc123&account=acct_1&token=tok&secret=shh&password=pw&auth=bearer&api_key=k1&code=xyz&key=k2";
    const result = sanitizeTelemetryUrl(url);
    for (const value of ["AAPL", "abc123", "acct_1", "tok", "shh", "pw", "bearer", "k1", "xyz", "k2"]) {
      expect(result).not.toContain(value);
    }
  });

  it("leaves non-sensitive params and the rest of the URL untouched", () => {
    const url = "/console/orders?page=2&sort=desc&symbol=AAPL#section";
    const result = sanitizeTelemetryUrl(url);
    expect(result).toBe("/console/orders?page=2&sort=desc&symbol=[REDACTED]#section");
  });

  it("is a no-op for URLs without a query string", () => {
    expect(sanitizeTelemetryUrl("/console/orders")).toBe("/console/orders");
  });

  it("handles non-string/empty input safely", () => {
    expect(sanitizeTelemetryUrl("")).toBe("");
    expect(sanitizeTelemetryUrl(undefined as unknown as string)).toBeUndefined();
  });
});

describe("redactTransactionEvent", () => {
  it("does not truncate event.spans past the generic redactor's maxArrayItems (20)", () => {
    const spans = Array.from({ length: 37 }, (_, i) => ({
      op: "http.client",
      description: `span-${i}`,
      data: { "http.method": "GET" }
    }));
    const event = { type: "transaction", spans };

    const result = redactTransactionEvent(event) as { spans: unknown[] };

    expect(Array.isArray(result.spans)).toBe(true);
    expect(result.spans).toHaveLength(37);
    // every entry must still be a real span object, not a "[truncated:N]" string
    for (const span of result.spans) {
      expect(typeof span).toBe("object");
      expect(span).not.toBeNull();
    }
  });

  it("redacts sensitive span.data keys and sanitizes URL-bearing span.data values", () => {
    const event = {
      type: "transaction",
      spans: [
        {
          op: "http.client",
          description: "GET /api/history?symbol=AAPL&apikey=SECRET1",
          data: {
            "http.url": "https://provider.example.com/query?apikey=SECRET2&symbol=AAPL",
            authorization: "Bearer SECRET3",
            "http.method": "GET"
          }
        }
      ]
    };

    const result = redactTransactionEvent(event) as {
      spans: Array<{ description: string; data: Record<string, unknown> }>;
    };

    const span = result.spans[0];
    expect(span.description).not.toContain("SECRET1");
    expect(span.data["http.url"]).not.toContain("SECRET2");
    expect(span.data["http.url"]).not.toContain("AAPL");
    expect(span.data.authorization).toBe("[redacted]");
    expect(span.data["http.method"]).toBe("GET");
  });

  it("still redacts non-span event fields via the generic redactor", () => {
    const event = {
      type: "transaction",
      spans: [],
      extra: { apiKey: "SECRET4", note: "fine" }
    };
    const result = redactTransactionEvent(event) as { extra: Record<string, unknown> };
    expect(result.extra.apiKey).toBe("[redacted]");
    expect(result.extra.note).toBe("fine");
  });
});

describe("sanitizeReplayRecordingEvent", () => {
  it("sanitizes URLs and secrets inside a Custom breadcrumb event's data.payload", () => {
    const event = {
      type: 5, // rrweb EventType.Custom
      timestamp: 123,
      data: {
        tag: "breadcrumb",
        payload: {
          category: "fetch",
          data: {
            url: "/api/proposals?proposal=prop_123&symbol=AAPL",
            method: "GET"
          }
        }
      }
    };

    const result = sanitizeReplayRecordingEvent(event) as typeof event;
    const payload = result.data.payload as { data: { url: string; method: string } };
    expect(payload.data.url).not.toContain("prop_123");
    expect(payload.data.url).not.toContain("AAPL");
    expect(payload.data.method).toBe("GET");
  });

  it("redacts sensitive keys anywhere in the payload, not just known URL fields", () => {
    const event = {
      type: 5,
      timestamp: 123,
      data: {
        tag: "breadcrumb",
        payload: { authorization: "Bearer SECRET", nested: { apiKey: "SECRET2" } }
      }
    };
    const result = sanitizeReplayRecordingEvent(event) as typeof event;
    const payload = result.data.payload as { authorization: string; nested: { apiKey: string } };
    expect(payload.authorization).toBe("[redacted]");
    expect(payload.nested.apiKey).toBe("[redacted]");
  });

  it("passes through events with no data.payload unchanged (e.g. non-Custom rrweb events)", () => {
    const event = { type: 4, timestamp: 123, data: { href: "https://example.com/console?symbol=AAPL" } };
    const result = sanitizeReplayRecordingEvent(event);
    expect(result).toEqual(event);
  });
});

describe("sanitizeReplayEnvelopeEvent", () => {
  it("sanitizes every URL in a replay_event's urls array in place", () => {
    const event = {
      type: "replay_event",
      urls: [
        "https://socratictrade.com/console/orders?symbol=AAPL",
        "https://socratictrade.com/console/proposals?proposal=prop_1&account=acct_1"
      ]
    };

    sanitizeReplayEnvelopeEvent(event);

    expect(event.urls[0]).not.toContain("AAPL");
    expect(event.urls[1]).not.toContain("prop_1");
    expect(event.urls[1]).not.toContain("acct_1");
  });

  it("is a no-op for non-replay_event types", () => {
    const event = { type: "transaction", urls: ["https://example.com?symbol=AAPL"] };
    sanitizeReplayEnvelopeEvent(event);
    expect(event.urls[0]).toContain("AAPL");
  });
});
