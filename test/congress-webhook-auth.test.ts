// Regression test for the congress.trade -> Socratic.Trade webhook signature
// mismatch: congress.trade signs with `X-Signature: sha256=<hex>` (see
// congress-trading-shared's signCongressWebhook), but this verifier used to
// compare the raw header (including the `sha256=` prefix) against the bare
// hex digest, so the length check always failed and every signed delivery
// was rejected with 401 (all SSE-only, webhook path dead on arrival).
import { createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyCongressWebhookSignature } from "../src/lib/congress-webhook-auth";

const SECRET = "test-congress-webhook-secret";
const BODY = JSON.stringify({ event: "trade.new", id: "ct-tx-1" });

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function reqWithSignature(signatureHeader: string): Request {
  return new Request("https://socratic.trade/api/webhooks/congress", {
    method: "POST",
    headers: { "x-signature": signatureHeader }
  });
}

beforeEach(() => {
  vi.stubEnv("CONGRESS_WEBHOOK_SECRET", SECRET);
});
afterEach(() => vi.unstubAllEnvs());

describe("verifyCongressWebhookSignature", () => {
  it("accepts the sha256=<hex> prefixed header congress.trade actually sends", () => {
    const hex = sign(BODY, SECRET);
    expect(verifyCongressWebhookSignature(reqWithSignature(`sha256=${hex}`), BODY)).toBe(true);
  });

  it("still accepts a bare hex signature with no prefix", () => {
    const hex = sign(BODY, SECRET);
    expect(verifyCongressWebhookSignature(reqWithSignature(hex), BODY)).toBe(true);
  });

  it("accepts an uppercase SHA256= prefix", () => {
    const hex = sign(BODY, SECRET);
    expect(verifyCongressWebhookSignature(reqWithSignature(`SHA256=${hex}`), BODY)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    const hex = sign(BODY, SECRET);
    const tampered = hex.slice(0, -1) + (hex.at(-1) === "0" ? "1" : "0");
    expect(verifyCongressWebhookSignature(reqWithSignature(`sha256=${tampered}`), BODY)).toBe(false);
  });

  it("rejects when no secret is configured", () => {
    vi.stubEnv("CONGRESS_WEBHOOK_SECRET", "");
    const hex = sign(BODY, SECRET);
    expect(verifyCongressWebhookSignature(reqWithSignature(`sha256=${hex}`), BODY)).toBe(false);
  });
});
