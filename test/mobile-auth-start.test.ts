import { describe, expect, it } from "vitest";
import { publicOrigin, sameOriginCallback } from "../src/lib/mobile-auth-start";

describe("publicOrigin", () => {
  it("resolves the forwarded host + proto (Coolify/Traefik shape)", () => {
    const headers = new Headers({
      "x-forwarded-proto": "https",
      "x-forwarded-host": "socratictrade.com",
      host: "localhost:3000"
    });
    expect(publicOrigin(headers)).toBe("https://socratictrade.com");
  });

  it("falls back to the Host header when x-forwarded-host is absent", () => {
    expect(publicOrigin(new Headers({ host: "socratictrade.com" }))).toBe("https://socratictrade.com");
  });

  it("falls back to the canonical origin with no host headers at all", () => {
    expect(publicOrigin(new Headers())).toBe("https://socratictrade.com");
  });

  it("uses the first proto of a comma-joined forwarded chain", () => {
    const headers = new Headers({
      "x-forwarded-proto": "https, http",
      "x-forwarded-host": "socratictrade.com"
    });
    expect(publicOrigin(headers)).toBe("https://socratictrade.com");
  });
});

describe("sameOriginCallback", () => {
  const PUBLIC = "https://socratictrade.com";

  it("keeps the absolute mobile handoff URL when the public origin matches (the owner-reported regression)", () => {
    expect(
      sameOriginCallback("https://socratictrade.com/api/mobile/auth-redirect?code_challenge=abc", PUBLIC)
    ).toBe("/api/mobile/auth-redirect?code_challenge=abc");
  });

  it("keeps the canonical-origin callback even when the resolved origin differs (internal request URL)", () => {
    expect(
      sameOriginCallback("https://socratictrade.com/api/mobile/auth-redirect?code_challenge=abc", "http://localhost:3000")
    ).toBe("/api/mobile/auth-redirect?code_challenge=abc");
  });

  it("keeps relative paths", () => {
    expect(sameOriginCallback("/console", PUBLIC)).toBe("/console");
  });

  it("clamps cross-origin callbacks to /", () => {
    expect(sameOriginCallback("https://evil.example.com/steal", PUBLIC)).toBe("/");
  });

  it("clamps garbage and empty input to /", () => {
    expect(sameOriginCallback("http://[malformed", PUBLIC)).toBe("/");
    expect(sameOriginCallback(null, PUBLIC)).toBe("/");
  });
});
