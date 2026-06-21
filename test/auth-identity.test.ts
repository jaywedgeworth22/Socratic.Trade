import { describe, expect, it } from "vitest";
import { isEmailAllowed, isPrimaryEmail, userIdForEmail } from "../src/lib/auth/identity";

describe("auth identity — multi-user keystone (Q3)", () => {
  it("primary email keeps the legacy 'local' id (no data migration); others get isolated stable ids", () => {
    expect(userIdForEmail("mail@jays.services")).toBe("local");
    expect(userIdForEmail("  MAIL@Jays.Services ")).toBe("local"); // normalized

    const a = userIdForEmail("alice@example.com");
    const b = userIdForEmail("bob@example.com");
    expect(a).toMatch(/^u_[0-9a-f]{24}$/);
    expect(a).not.toBe("local");
    expect(a).not.toBe(b);
    expect(userIdForEmail("ALICE@example.com")).toBe(a); // deterministic + case-insensitive
  });

  it("invalid emails fall back to the dev user rather than minting a junk tenant", () => {
    expect(userIdForEmail("")).toBe("local");
    expect(userIdForEmail("not-an-email")).toBe("local");
  });

  it("allowlist: primary always allowed; with no ALLOWED_EMAILS set, defers to the gateway (open)", () => {
    expect(isPrimaryEmail("mail@jays.services")).toBe(true);
    expect(isEmailAllowed("mail@jays.services")).toBe(true);
    expect(isEmailAllowed("anyone@example.com")).toBe(true); // no env allowlist in test → CF Access is the gate
    expect(isEmailAllowed("")).toBe(false);
  });
});
