/**
 * Pure helpers for the learned-context confirmation queue UI.
 * No React, no I/O — pure functions so they can be unit-tested.
 */

export type PendingTier = "risk" | "strategy-directive";

/** Maps a pending tier to the Chip tone used in the UI. */
export function tierTone(tier: PendingTier): "warn" | "info" {
  return tier === "risk" ? "warn" : "info";
}

/** Maps a pending tier to a human-readable label. */
export function tierLabel(tier: PendingTier): string {
  return tier === "risk" ? "Risk" : "Strategy Directive";
}

/**
 * Formats the attributed AI-LEARNED block that approval will append to the
 * strategy prompt for a 'strategy-directive' item.
 *
 * @param id  - The pending item ID (used as the block identifier).
 * @param date - ISO date string (createdAt); only the date portion is shown.
 * @param value - The directive text.
 */
export function formatStrategyDirectiveBlock(id: string, date: string, value: string): string {
  // Trim to a safe date prefix (YYYY-MM-DD) if the string is ISO-formatted.
  const datePart = date.length >= 10 ? date.slice(0, 10) : date;
  return `<!-- AI-LEARNED ${id} ${datePart} -->\n${value}\n<!-- /AI-LEARNED -->`;
}

/**
 * Returns a concise relative date label for display (e.g. "Today", "Yesterday",
 * "3 days ago", or the ISO date string for older items).
 *
 * @param isoDate - ISO 8601 date/datetime string.
 * @param now     - Optional Date for the current time (defaults to Date.now()).
 */
export function relativeDate(isoDate: string, now?: Date): string {
  const then = new Date(isoDate);
  if (isNaN(then.getTime())) return isoDate;
  const base = now ?? new Date();
  const diffMs = base.getTime() - then.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return then.toISOString().slice(0, 10);
}
