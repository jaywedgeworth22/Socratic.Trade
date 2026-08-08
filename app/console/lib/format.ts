/** Formatting helpers for the console. One rule everywhere: missing data
 *  renders as "—" (em dash) — never a fabricated number. */

export const EM_DASH = "—";

/** Owner-wide copy rule (2026-08-08 mobile punch list): sentences inside one
 *  paragraph are separated by TWO spaces. HTML collapses consecutive plain
 *  spaces to one, so the gap is rendered as NBSP + space — interpose
 *  {SENTENCE_GAP} between sentences in JSX copy instead of a literal "  ". */
export const SENTENCE_GAP = "\u00A0 ";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const numFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function fmtMoney(v: number | null | undefined): string {
  return isNum(v) ? usd.format(v) : EM_DASH;
}

export function fmtMoneyWhole(v: number | null | undefined): string {
  return isNum(v) ? usdWhole.format(v) : EM_DASH;
}

export function fmtSignedMoney(v: number | null | undefined): string {
  if (!isNum(v)) return EM_DASH;
  return `${v > 0 ? "+" : ""}${usd.format(v)}`;
}

export function fmtPct(v: number | null | undefined, digits = 2, signed = false): string {
  if (!isNum(v)) return EM_DASH;
  let text = v.toFixed(digits);
  // Never render negative zero (owner rule, 2026-08-08): -0 and tiny negatives
  // that round to "-0.0" display as plain zero.
  if (/^-0(\.0+)?$/.test(text)) text = text.slice(1);
  const sign = signed && v > 0 ? "+" : "";
  return `${sign}${text}%`;
}

export function fmtNum(v: number | null | undefined): string {
  return isNum(v) ? numFmt.format(v) : EM_DASH;
}

export function fmtQty(v: number | null | undefined): string {
  if (!isNum(v)) return EM_DASH;
  return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

/** Humanized relative time ("3m ago"); pair with fmtExact for the hover. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return EM_DASH;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return EM_DASH;
  const diff = now - t;
  if (diff < 0) return timeUntil(iso, now);
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

export function timeUntil(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return EM_DASH;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return EM_DASH;
  const diff = t - now;
  if (diff <= 0) return "now";
  const m = Math.ceil(diff / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h ${m % 60}m`;
  return `in ${Math.floor(h / 24)}d`;
}

/** Exact timestamp for tooltips: "Jul 2, 2026, 2:41:07 PM". */
export function fmtExact(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return EM_DASH;
  return t.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function fmtClock(date: Date | null | undefined): string {
  if (!date) return EM_DASH;
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return EM_DASH;
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(t, today)) return "Today";
  if (sameDay(t, yesterday)) return "Yesterday";
  return t.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** Local calendar-day key (for grouping feeds by day). */
export function dayKey(iso: string): string {
  const t = new Date(iso);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}
