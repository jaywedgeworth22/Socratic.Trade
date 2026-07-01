import { afterEach, describe, expect, it } from "vitest";

// PR #5 gap #2: the public explainer moved /strategy → /how-it-works. The old
// path is a redirect shim whose redirect is ITSELF gated by LANDING_PAGE_ENABLED,
// so both paths 404 when the landing page is disabled (rather than /strategy
// redirecting to a page that also 404s).
describe("/how-it-works redirect + gate (PR #5)", () => {
  const original = process.env.LANDING_PAGE_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.LANDING_PAGE_ENABLED;
    else process.env.LANDING_PAGE_ENABLED = original;
  });

  it("both /strategy and /how-it-works 404 when the landing page is disabled", async () => {
    process.env.LANDING_PAGE_ENABLED = "false";
    const StrategyRedirect = (await import("../app/strategy/page")).default;
    const HowItWorks = (await import("../app/how-it-works/page")).default;
    // notFound() throws a control-flow error; neither should return content.
    expect(() => StrategyRedirect()).toThrow();
    expect(() => HowItWorks()).toThrow();
  });

  it("/strategy redirects to /how-it-works when the landing page is enabled", async () => {
    process.env.LANDING_PAGE_ENABLED = "true";
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

  it("/how-it-works renders (does not throw) when enabled", async () => {
    process.env.LANDING_PAGE_ENABLED = "true";
    const HowItWorks = (await import("../app/how-it-works/page")).default;
    expect(() => HowItWorks()).not.toThrow();
  });
});
