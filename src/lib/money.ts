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

export function formatQuantity(value: number | undefined | null, symbol?: string): string {
  if (value == null) return "0";
  const abs = Math.abs(value);
  if (abs === 0) return "0";

  if (abs >= 1000) {
    return Math.round(value).toString();
  }

  // Under 1000 shares: 3 significant figures
  // Using Number(...) removes trailing zeros like "10.0" -> "10"
  let str = Number(value.toPrecision(3)).toString();
  
  // For extremely small numbers that use e-notation
  if (str.includes("e")) {
    str = Number(value.toPrecision(3)).toLocaleString("en-US", { maximumFractionDigits: 10, useGrouping: false });
  }
  
  return str;
}

