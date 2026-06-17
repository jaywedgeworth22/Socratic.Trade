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

export function formatQuantity(value: number | undefined | null, _symbol?: string): string {
  if (value == null) return "0";
  const abs = Math.abs(value);
  if (abs === 0) return "0";

  // Significant figures to show: at least 3, but always enough to show EVERY integer
  // digit so a large whole-share count is never truncated — i.e. "3 significant figures
  // OR all digits of the whole number, whichever is larger" (12,489.242 -> "12,489";
  // 0.167333 -> "0.167"; 1.5 -> "1.5"). Comma-grouped; trailing zeros stripped.
  const intDigits = abs >= 1 ? Math.trunc(abs).toString().length : 0;
  const sigFigs = Math.max(3, intDigits);
  return Number(value.toPrecision(sigFigs)).toLocaleString("en-US", { maximumFractionDigits: 20 });
}

