export function asMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(value);
}

export function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}
