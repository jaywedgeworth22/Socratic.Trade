import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { POST } from "../app/api/mobile/auth/exchange/route";
import { createMobileAuthHandoff } from "../src/lib/mobile-auth-handoff";

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

describe("mobile OAuth exchange route", () => {
  it("returns no session credential in its JSON response and sets an HTTP-only cookie", async () => {
    const verifier = "v".repeat(43);
    const code = createMobileAuthHandoff({
      sessionToken: "session-secret",
      codeChallenge: challenge(verifier)
    });
    const response = await POST(new Request("https://socratictrade.com/api/mobile/auth/exchange", {
      method: "POST",
      body: JSON.stringify({ code, codeVerifier: verifier })
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("authjs.session-token=session-secret");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
  });
});
