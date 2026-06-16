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

  const isExtra = symbol ? ["NVDA", "INTC", "QCOM"].includes(symbol.trim().toUpperCase()) : false;

  if (abs >= 10000) {
    return value.toFixed(isExtra ? 1 : 0);
  } else if (abs >= 1000) {
    return value.toFixed(isExtra ? 2 : 1);
  } else if (abs >= 10) {
    return value.toFixed(isExtra ? 3 : 2);
  } else {
    const prec = value.toPrecision(isExtra ? 4 : 3);
    if (prec.includes("e")) {
      return Number(prec).toString();
    }
    return prec;
  }
}

