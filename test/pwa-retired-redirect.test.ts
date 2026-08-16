import { describe, expect, it } from "vitest";

describe("PWA retired", () => {
  it("/mobile redirects to /console", async () => {
    const MobilePage = (await import("../app/mobile/page")).default;
    let digest = "";
    try {
      MobilePage();
    } catch (err) {
      digest = String((err as { digest?: string })?.digest ?? err);
    }
    expect(digest).toContain("NEXT_REDIRECT");
    expect(digest).toContain("/console");
  });
});
