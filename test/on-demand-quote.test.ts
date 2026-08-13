import { describe, expect, it } from "vitest";
import {
  composeOnDemandQuote,
  fastQuoteEnrichment,
  mergeOnDemandEnrichment
} from "../src/lib/on-demand-quote";

describe("fastQuoteEnrichment", () => {
  it("maps chart-floor fundamentals when Yahoo actually returned them", () => {
    const enrichment = fastQuoteEnrichment({
      companyName: "Alphabet Inc.",
      price: 343.94,
      bid: 343.6,
      ask: 344.3,
      prevClose: 342.2,
      volume: 14_897_228,
      asOf: "2026-08-13T20:00:00.000Z",
      peRatio: 26.4,
      fiftyTwoWeekHigh: 208.7,
      fiftyTwoWeekLow: 142.66,
      syntheticBid: true,
      syntheticAsk: true,
      syntheticSpread: true
    });
    expect(enrichment).toMatchObject({
      companyName: "Alphabet Inc.",
      price: 343.94,
      volume: 14_897_228,
      peRatio: 26.4,
      fiftyTwoWeekHigh: 208.7,
      fiftyTwoWeekLow: 142.66,
      sources: {
        companyName: "yahoo-finance",
        price: "yahoo-finance",
        peRatio: "yahoo-finance",
        fiftyTwoWeekHigh: "yahoo-finance",
        fiftyTwoWeekLow: "yahoo-finance"
      }
    });
    expect(enrichment.bid).toBeUndefined();
    expect(enrichment.ask).toBeUndefined();
  });
});

describe("composeOnDemandQuote", () => {
  it("keeps durable PE when live layers omit it, and lets a newer live price win", () => {
    const composed = composeOnDemandQuote([
      { peRatio: 26.4, eps: 8.12, sources: { peRatio: "symbol-field-latest" } },
      {
        price: 343.94,
        volume: 14_897_228,
        asOf: "2026-08-13T20:00:00.000Z",
        sources: { price: "yahoo-finance", volume: "yahoo-finance" }
      },
      { peRatio: 27.1, sources: { peRatio: "yahoo-finance" } }
    ]);
    expect(composed).toMatchObject({
      price: 343.94,
      volume: 14_897_228,
      peRatio: 27.1,
      eps: 8.12,
      sources: {
        price: "yahoo-finance",
        peRatio: "yahoo-finance"
      }
    });
  });

  it("does not let an older rich price erase a newer chart floor", () => {
    const merged = mergeOnDemandEnrichment(
      {
        price: 343.94,
        asOf: "2026-08-13T20:01:00.000Z",
        sources: { price: "yahoo-finance", asOf: "yahoo-finance" }
      },
      {
        price: 340,
        asOf: "2026-08-13T19:00:00.000Z",
        sources: { price: "alpaca", asOf: "alpaca" }
      }
    );
    expect(merged.price).toBe(343.94);
    expect(merged.sources?.price).toBe("yahoo-finance");
  });
});
