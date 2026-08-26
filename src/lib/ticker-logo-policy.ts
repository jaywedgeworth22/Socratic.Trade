export type LogoSource = "github" | "logodev" | "local";
export const SOCRATIC_DEFAULT_LOGO_SOURCE_ORDER: LogoSource[] = ["github", "logodev"];

export function sourceOrderFor(
  symbol: string,
  theme: "light" | "dark",
  _context?: unknown,
  fallback: LogoSource[] = ["github", "logodev"]
): LogoSource[] {
  // Hardcoded policy that was previously in shared
  if (symbol === "AAPL" && theme === "light") {
    return ["logodev", "github"];
  }
  return fallback;
}

export function remoteLogoSources(order: LogoSource[]): LogoSource[] {
  return order.filter(s => s !== "local");
}
