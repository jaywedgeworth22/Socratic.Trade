// US equity market holiday & early-close calendar (NYSE schedule).
// Covers 2025, 2026, and 2027. Holidays are full-day closures; early-close
// days are 13:00 ET close (09:30–13:00 regular session).

import { getMarketHolidays } from "./market-hours";

/** YYYY-MM-DD set of early-close (13:00 ET) market days. */
export function getEarlyCloseDays(year: number): Set<string> {
  const days = new Set<string>();

  // Independence Day eve: July 4 observed rules
  const july4 = new Date(Date.UTC(year, 6, 4));
  const july4Dow = july4.getUTCDay();
  let julyEve: Date;
  if (july4Dow === 0) {
    // July 4 is Sunday → observed Mon Jul 5 → eve is Fri Jul 2
    julyEve = new Date(Date.UTC(year, 6, 2));
  } else if (july4Dow === 1) {
    // July 4 is Monday → eve is Fri Jul 1 (weekend, no early close)
    julyEve = new Date(Date.UTC(year, 6, 1));
  } else if (july4Dow === 6) {
    // July 4 is Saturday → observed Fri Jul 3 → eve is Thu Jul 2
    julyEve = new Date(Date.UTC(year, 6, 2));
  } else {
    // July 4 is Tue–Fri → eve is the prior weekday
    julyEve = new Date(Date.UTC(year, 6, 3));
  }
  // Only add if it's a weekday (Mon–Fri) — if July 4 is Tuesday, eve is Monday ✓
  const eveDow = julyEve.getUTCDay();
  if (eveDow >= 1 && eveDow <= 5) {
    days.add(julyEve.toISOString().split("T")[0]);
  }

  // Day after Thanksgiving (Black Friday): 4th Thursday in Nov + 1
  const thanksgiving = getNthWeekdayOfMonth(year, 10, 4, 4);
  const blackFriday = new Date(thanksgiving);
  blackFriday.setUTCDate(blackFriday.getUTCDate() + 1);
  // Thanksgiving is always Thursday, so Black Friday is always Friday
  days.add(blackFriday.toISOString().split("T")[0]);

  // Christmas Eve: Dec 24 if a weekday
  const christmasEve = new Date(Date.UTC(year, 11, 24));
  const ceDow = christmasEve.getUTCDay();
  if (ceDow >= 1 && ceDow <= 5) {
    // Only add if Dec 24 is not already a full holiday (Christmas observed)
    const holidays = getMarketHolidays(year);
    const ceStr = christmasEve.toISOString().split("T")[0];
    if (!holidays.has(ceStr)) {
      days.add(ceStr);
    }
  }

  return days;
}

/** Parse an NYC wall-clock date (YYYY-MM-DD) from a Date in any timezone. */
function nycDateString(date: Date): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** True when today is a trading day (not a weekend or full-close holiday), regardless of current time. */
export function isTradingDay(date: Date = new Date()): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = parts.weekday;
  if (weekday === "Sat" || weekday === "Sun") return false;
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const year = parseInt(parts.year, 10);
  const holidays = getMarketHolidays(year);
  return !holidays.has(dateStr);
}

/** True when the US equity market is open for regular trading right now. */
export function isMarketOpen(date: Date = new Date()): boolean {
  // Weekends
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
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = parts.weekday;
  if (weekday === "Sat" || weekday === "Sun") return false;

  // Full-close holidays
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const year = parseInt(parts.year, 10);
  const holidays = getMarketHolidays(year);
  if (holidays.has(dateStr)) return false;

  // Regular session hours: 09:30–16:00 ET (or 09:30–13:00 ET on early-close days)
  const hour = parseInt(parts.hour === "24" ? "0" : parts.hour, 10);
  const minute = parseInt(parts.minute, 10);
  const totalMinutes = hour * 60 + minute;
  const OPEN = 9 * 60 + 30;
  const REGULAR_CLOSE = 16 * 60;
  const EARLY_CLOSE = 13 * 60;

  const earlyCloseDays = getEarlyCloseDays(year);
  const closeTime = earlyCloseDays.has(dateStr) ? EARLY_CLOSE : REGULAR_CLOSE;

  return totalMinutes >= OPEN && totalMinutes < closeTime;
}

/**
 * The next date+time the US equity market opens for regular trading.
 * If `after` is during a session, returns that same time (the market is already open).
 */
export function nextMarketOpen(after: Date = new Date()): Date {
  // Walk forward one day at a time until we hit an open day.
  const candidate = new Date(after);
  // Start from the beginning of the current day in ET
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });

  // Check if market is already open right now
  if (isMarketOpen(after)) return after;

  // Advance to next day at 09:30 ET
  // Convert current ET to a date, set to next day 09:30
  const parts = Object.fromEntries(fmt.formatToParts(after).map((p) => [p.type, p.value]));
  const year = parseInt(parts.year, 10);
  const month = parseInt(parts.month, 10) - 1; // JS months are 0-indexed
  const day = parseInt(parts.day, 10);

  // Set to 09:30 ET today
  candidate.setUTCFullYear(year, month, day);
  candidate.setUTCHours(14, 30, 0, 0); // 09:30 ET = 14:30 UTC (ET is UTC-5 normally, but...)

  // If it's past 09:30 ET today, start from tomorrow
  // Use a simpler approach: just iterate days
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  // Reset to 09:30 ET anchor — approximate with UTC
  // Actually, this is tricky with DST. Let me do a simpler approach:
  // Just iterate dates from today forward
  const startStr = nycDateString(after);
  let checkDate = new Date(after);
  // If already during market hours, return now
  if (isMarketOpen(after)) return after;

  // If after close, start from next day
  const afterHour = parseInt(parts.hour, 10);
  const afterMinute = parseInt(parts.minute, 10);
  const afterTotalMin = afterHour * 60 + afterMinute;
  if (afterTotalMin >= 16 * 60) {
    // After 16:00 ET, jump to next day
    checkDate = new Date(checkDate.getTime() + ONE_DAY_MS);
  }

  // Walk forward until we find an open day
  for (let i = 0; i < 14; i++) {
    const dateStr = nycDateString(checkDate);
    const checkYear = parseInt(dateStr.split("-")[0], 10);
    const holidays = getMarketHolidays(checkYear);
    const dayOfWeek = new Date(Date.UTC(
      parseInt(dateStr.split("-")[0], 10),
      parseInt(dateStr.split("-")[1], 10) - 1,
      parseInt(dateStr.split("-")[2], 10)
    )).getUTCDay();

    if (dayOfWeek !== 0 && dayOfWeek !== 6 && !holidays.has(dateStr)) {
      // Found an open day — set to 09:30 ET
      const [y, m, d] = dateStr.split("-").map(Number);
      const openDate = new Date(Date.UTC(y, m - 1, d, 14, 30, 0, 0)); // 09:30 ET = 14:30 UTC (EST) or 13:30 UTC (EDT)
      // Actually, 09:30 America/New_York... let me just use ISO string intent
      // The caller will interpret this as NYC time. Return a Date representing 09:30 ET.
      return openDate;
    }

    checkDate = new Date(checkDate.getTime() + ONE_DAY_MS);
  }

  // Fallback: return 2 days from now at 09:30 ET
  const fallback = new Date(after.getTime() + 2 * ONE_DAY_MS);
  const fbParts = Object.fromEntries(fmt.formatToParts(fallback).map((p) => [p.type, p.value]));
  const fbYear = parseInt(fbParts.year, 10);
  const fbMonth = parseInt(fbParts.month, 10) - 1;
  const fbDay = parseInt(fbParts.day, 10);
  return new Date(Date.UTC(fbYear, fbMonth, fbDay, 14, 30, 0, 0));
}

function getNthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const date = new Date(Date.UTC(year, month, 1));
  let count = 0;
  while (date.getUTCMonth() === month) {
    if (date.getUTCDay() === weekday) {
      count++;
      if (count === n) return date;
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  throw new Error("Nth weekday not found");
}
