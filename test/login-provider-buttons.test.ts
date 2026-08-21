import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Owner 2026-08-21: the three provider buttons are one light pill with matching
 * monochrome marks.  Do not reintroduce the teal Google / outline GitHub / black
 * Apple split, the four-color G, or an email/password form.
 */
describe("login provider buttons: one light pill, monochrome marks", () => {
  const web = readFileSync(new URL("../app/login/page.tsx", import.meta.url), "utf8");
  const ios = readFileSync(new URL("../ios/SocraticTrade/LoginView.swift", import.meta.url), "utf8");

  it("web uses one shared pill class for Google, GitHub, and Apple", () => {
    expect(web).toContain("const PROVIDER_BUTTON_CLASS");
    expect(web).toContain("rounded-full");
    expect(web).toContain("bg-white");
    expect(web.match(/className=\{PROVIDER_BUTTON_CLASS\}/g)?.length).toBe(3);
    expect(web).not.toMatch(/bg-accent px-5/);
    expect(web).not.toMatch(/bg-fg px-5/);
  });

  it("web Google / GitHub / Apple marks all inherit currentColor", () => {
    expect(web).toMatch(/function GoogleIcon\(\)[\s\S]*fill="currentColor"/);
    expect(web).toMatch(/function GitHubIcon\(\)[\s\S]*fill="currentColor"/);
    expect(web).toMatch(/function AppleIcon\(\)[\s\S]*fill="currentColor"/);
    expect(web).not.toContain("#4285F4");
    expect(web).not.toContain("#34A853");
    expect(web).not.toContain("#EA4335");
  });

  it("web login does not add email/password or passkey fields", () => {
    expect(web).not.toMatch(/type=["']password["']/);
    expect(web).not.toMatch(/type=["']email["']/);
    expect(web).not.toMatch(/signIn\(["']credentials["']/);
    expect(web.toLowerCase()).not.toContain("passkey");
  });

  it("iOS uses the same light capsule for every provider and a monochrome G", () => {
    expect(ios).toContain("Capsule(style: .continuous)");
    expect(ios).toContain("struct GoogleMark");
    expect(ios).toContain("var ink: Color");
    expect(ios).not.toContain("#4285F4");
    expect(ios).not.toContain("0x42 / 255");
    expect(ios).not.toMatch(/SignInWithAppleButton\s*\(/);
  });
});
