import { describe, expect, it, vi } from "vitest";
import { CascadingEnrichmentProvider, type MarketEnrichmentProvider } from "../src/lib/data-providers";

describe("CascadingEnrichmentProvider gather abort", () => {
  it("forwards the gather signal into the keyed wave and stops when it fires", async () => {
    const controller = new AbortController();
    let paidSignal: AbortSignal | undefined;
    const free: MarketEnrichmentProvider = {
      name: "yahoo-finance",
      configured: true,
      costTier: "free",
      async enrich() {
        return {};
      }
    };
    const paid: MarketEnrichmentProvider = {
      name: "finnhub",
      configured: true,
      costTier: "paid",
      suppliesFields: ["sentiment"],
      async enrich(_symbols, context) {
        paidSignal = context?.signal;
        return new Promise((_resolve, reject) => {
          context?.signal?.addEventListener(
            "abort",
            () => reject(context.signal?.reason ?? new Error("aborted")),
            { once: true }
          );
        });
      }
    };

    const cascade = new CascadingEnrichmentProvider([free, paid]);
    const pending = cascade.enrich(["AAPL"], { signal: controller.signal });
    pending.catch(() => undefined);
    await vi.waitFor(() => {
      expect(paidSignal).toBe(controller.signal);
    });
    controller.abort(new Error("strategy gather timeout"));
    await expect(pending).rejects.toThrow("strategy gather timeout");
  });
});
