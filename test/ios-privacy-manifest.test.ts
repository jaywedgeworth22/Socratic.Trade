import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const privacyManifest = readFileSync(
  resolve(process.cwd(), "ios/SocraticTrade/PrivacyInfo.xcprivacy"),
  "utf8"
);
const projectYml = readFileSync(resolve(process.cwd(), "ios/project.yml"), "utf8");
const infoPlist = readFileSync(resolve(process.cwd(), "ios/SocraticTrade/Info.plist"), "utf8");

describe("iOS release-readiness plist + privacy manifest", () => {
  it("declares export compliance so TestFlight does not sit on Missing Compliance", () => {
    expect(infoPlist).toContain("<key>ITSAppUsesNonExemptEncryption</key>");
    expect(infoPlist).toMatch(/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
    expect(projectYml).toMatch(/ITSAppUsesNonExemptEncryption:\s*false/);
    expect(infoPlist).toContain("<string>Socratic Trade</string>");
    expect(projectYml).toMatch(/CFBundleDisplayName:\s*Socratic Trade/);
  });

  it("ships a privacy manifest that XcodeGen copies as a resource", () => {
    expect(privacyManifest).toContain("<key>NSPrivacyTracking</key>");
    expect(privacyManifest).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/);
    expect(privacyManifest).toContain("NSPrivacyAccessedAPICategoryUserDefaults");
    expect(privacyManifest).toContain("CA92.1");
    expect(privacyManifest).toContain("NSPrivacyCollectedDataTypeDeviceID");
    expect(privacyManifest).not.toMatch(/<key>NSPrivacyTracking<\/key>\s*<true\/>/);
    expect(projectYml).toContain("SocraticTrade/PrivacyInfo.xcprivacy");
    expect(projectYml).toMatch(/buildPhase:\s*resources/);
  });
});
