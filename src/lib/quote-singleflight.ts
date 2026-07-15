import type { SymbolEnrichment } from "./data-providers";

/** Keep a timed-out on-demand cascade useful to later opens instead of starting
 * another full provider fan-out for the same user and symbol. */
const activeQuotes = new Map<string, Promise<SymbolEnrichment>>();

export function runQuoteEnrichmentSingleFlight(
  key: string,
  factory: () => Promise<SymbolEnrichment>
): Promise<SymbolEnrichment> {
  const existing = activeQuotes.get(key);
  if (existing) return existing;

  const pending = Promise.resolve().then(factory);
  activeQuotes.set(key, pending);
  const clear = () => {
    if (activeQuotes.get(key) === pending) activeQuotes.delete(key);
  };
  void pending.then(clear, clear);
  return pending;
}

export function resetQuoteSingleFlightForTests(): void {
  activeQuotes.clear();
}
