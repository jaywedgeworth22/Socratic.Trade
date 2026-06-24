import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { SseParser, applySseMessage } from "../src/lib/congress-stream";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-congress-stream-${randomUUID()}.db`)}`;
});

describe("SseParser", () => {
  it("parses a complete event with event/id/data fields", () => {
    const msgs = new SseParser().push("event: congress.trade\nid: e1\ndata: {\"a\":1}\n\n");
    expect(msgs).toEqual([{ event: "congress.trade", id: "e1", data: '{"a":1}' }]);
  });

  it("joins multi-line data and ignores comments/heartbeats", () => {
    const msgs = new SseParser().push(": heartbeat\ndata: line1\ndata: line2\n\n");
    expect(msgs).toEqual([{ event: undefined, id: undefined, data: "line1\nline2" }]);
  });

  it("handles events split across chunk boundaries", () => {
    const p = new SseParser();
    expect(p.push("data: {\"x\"")).toEqual([]); // incomplete — nothing dispatched yet
    expect(p.push(":5}\n\n")).toEqual([{ event: undefined, id: undefined, data: '{"x":5}' }]);
  });

  it("emits multiple events from one chunk and strips a single leading space after the colon", () => {
    const msgs = new SseParser().push("data:a\n\ndata: b\n\n");
    expect(msgs.map((m) => m.data)).toEqual(["a", "b"]);
  });
});

describe("applySseMessage", () => {
  it("returns false on unparseable data", () => {
    expect(applySseMessage({ data: "{not json" })).toBe(false);
    expect(applySseMessage({ data: "" })).toBe(false);
  });

  it("applies a valid envelope, merging the SSE event/id into the envelope", () => {
    // ref.upsert is an informational no-op (no DB write) but still a valid applied event.
    expect(applySseMessage({ event: "ref.upsert", id: `e-${randomUUID()}`, data: JSON.stringify({ data: { ticker: "AAPL" } }) })).toBe(true);
  });
});
