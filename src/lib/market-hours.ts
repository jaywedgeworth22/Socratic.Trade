// US market session detector using America/New_York wall-clock time.
// Regular session: Mon–Fri 09:30–16:00 ET.
// Extended: pre-market 04:00–09:30 ET, post-market 16:00–20:00 ET.
// Market holidays ARE modeled via getMarketHolidays() (see lines below).

export type MarketSession = "closed" | "regular" | "pre" | "post";

export function currentMarketSession(now = new Date()): MarketSession {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const weekday = parts.weekday; // "Mon", "Tue", ..., "Sat", "Sun"
  if (weekday === "Sat" || weekday === "Sun") return "closed";

  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const holidays = getMarketHolidays(parseInt(parts.year, 10));
  if (holidays.has(dateStr)) return "closed";

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

export function getMarketHolidays(year: number): Set<string> {
  const holidays = new Set<string>();

  // 1. New Year's Day (observed)
  const ny = getObservedHoliday(year, 0, 1);
  holidays.add(ny.toISOString().split("T")[0]);
  
  // If Jan 1 of NEXT year is Saturday, Friday Dec 31 of this year is observed
  const nextYearNy = new Date(Date.UTC(year + 1, 0, 1));
  if (nextYearNy.getUTCDay() === 6) {
    holidays.add(`${year}-12-31`);
  }

  // 2. MLK Day: 3rd Monday in Jan
  holidays.add(getNthWeekdayOfMonth(year, 0, 1, 3).toISOString().split("T")[0]);

  // 3. Presidents' Day: 3rd Monday in Feb
  holidays.add(getNthWeekdayOfMonth(year, 1, 1, 3).toISOString().split("T")[0]);

  // 4. Good Friday
  holidays.add(getGoodFriday(year).toISOString().split("T")[0]);

  // 5. Memorial Day: Last Monday in May
  holidays.add(getLastWeekdayOfMonth(year, 4, 1).toISOString().split("T")[0]);

  // 6. Juneteenth (observed)
  holidays.add(getObservedHoliday(year, 5, 19).toISOString().split("T")[0]);

  // 7. Independence Day (observed)
  holidays.add(getObservedHoliday(year, 6, 4).toISOString().split("T")[0]);

  // 8. Labor Day: 1st Monday in Sep
  holidays.add(getNthWeekdayOfMonth(year, 8, 1, 1).toISOString().split("T")[0]);

  // 9. Thanksgiving: 4th Thursday in Nov
  holidays.add(getNthWeekdayOfMonth(year, 10, 4, 4).toISOString().split("T")[0]);

  // 10. Christmas Day (observed)
  holidays.add(getObservedHoliday(year, 11, 25).toISOString().split("T")[0]);

  return holidays;
}

function getNthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const date = new Date(Date.UTC(year, month, 1));
  let count = 0;
  while (date.getUTCMonth() === month) {
    if (date.getUTCDay() === weekday) {
      count++;
      if (count === n) {
        return date;
      }
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  throw new Error("Nth weekday not found");
}

function getLastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const date = new Date(Date.UTC(year, month + 1, 0));
  while (date.getUTCMonth() === month) {
    if (date.getUTCDay() === weekday) {
      return date;
    }
    date.setUTCDate(date.getUTCDate() - 1);
  }
  throw new Error("Last weekday not found");
}

function getObservedHoliday(year: number, month: number, day: number): Date {
  const date = new Date(Date.UTC(year, month, day));
  const dow = date.getUTCDay();
  if (dow === 0) {
    date.setUTCDate(day + 1);
  } else if (dow === 6) {
    date.setUTCDate(day - 1);
  }
  return date;
}

function getGoodFriday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = new Date(Date.UTC(year, month, day));
  easter.setUTCDate(easter.getUTCDate() - 2);
  return easter;
}
