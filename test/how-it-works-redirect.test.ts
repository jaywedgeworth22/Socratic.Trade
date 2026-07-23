import { describe, expect, it } from "vitest";

// PR #5 gap #2: the public explainer moved /strategy → /how-it-works. The old
// path is a redirect shim, while /how-it-works renders as the public framework page
// by default.
describe("/how-it-works redirect", () => {
  it("/strategy redirects to /how-it-works", async () => {
    const StrategyRedirect = (await import("../app/strategy/page")).default;
    let digest = "";
    try {
      StrategyRedirect();
    } catch (err) {
      digest = String((err as { digest?: string })?.digest ?? err);
    }
    expect(digest).toContain("NEXT_REDIRECT");
    expect(digest).toContain("/how-it-works");
  });

  it("/how-it-works renders", async () => {
    const HowItWorks = (await import("../app/how-it-works/page")).default;
    expect(() => HowItWorks()).not.toThrow();
  });
});
