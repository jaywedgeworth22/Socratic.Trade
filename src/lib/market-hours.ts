// US market session detector using America/New_York wall-clock time.
// Regular session: Mon–Fri 09:30–16:00 ET.
// Extended: pre-market 04:00–09:30 ET, post-market 16:00–20:00 ET.
// NOTE: Does NOT account for market holidays (Phase 1 documented limitation).

export type MarketSession = "closed" | "regular" | "pre" | "post";

export function currentMarketSession(now = new Date()): MarketSession {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit"
  });

  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const weekday = parts.weekday; // "Mon", "Tue", ..., "Sat", "Sun"
  if (weekday === "Sat" || weekday === "Sun") return "closed";

  // hour12: false gives "00"–"23"; pad handles "24" edge case Intl sometimes emits for midnight
  const hour = parseInt(parts.hour === "24" ? "0" : parts.hour, 10);
  const minute = parseInt(parts.minute, 10);
  const totalMinutes = hour * 60 + minute;

  const PRE_OPEN = 4 * 60;       // 04:00
  const OPEN = 9 * 60 + 30;      // 09:30
  const CLOSE = 16 * 60;         // 16:00
  const POST_CLOSE = 20 * 60;    // 20:00

  if (totalMinutes >= OPEN && totalMinutes < CLOSE) return "regular";
  if (totalMinutes >= PRE_OPEN && totalMinutes < OPEN) return "pre";
  if (totalMinutes >= CLOSE && totalMinutes < POST_CLOSE) return "post";
  return "closed";
}

// Returns true if a strategy run is allowed right now given the policy preference.
export function isRunAllowedNow(runDuringExtendedHours: boolean, now = new Date()): boolean {
  const session = currentMarketSession(now);
  if (session === "regular") return true;
  if (runDuringExtendedHours && (session === "pre" || session === "post")) return true;
  return false;
}
