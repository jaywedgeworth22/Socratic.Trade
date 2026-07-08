"use client";

/** Console UI primitives. Own design system — no imports from app/ui/*. */

import { useState, useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cx, fmtExact, timeAgo, EM_DASH } from "../lib/format";
import { AnimatePresence, motion } from "motion/react";

// ── Card ─────────────────────────────────────────────────────────────────────


export function Card({
  title,
  action,
  children,
  className,
  padded = true
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={cx("con-card", className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-1">
          {title ? <h2 className="con-card-title">{title}</h2> : <span />}
          {action}
        </header>
      )}
      <div className={padded ? "px-4 pb-4 pt-2" : undefined}>{children}</div>
    </section>
  );
}

// ── Button ───────────────────────────────────────────────────────────────────

export type BtnVariant = "primary" | "outline" | "ghost" | "danger" | "dangerOutline" | "pos";

const BTN_CLASS: Record<BtnVariant, string> = {
  primary: "con-btn-primary",
  outline: "con-btn-outline",
  ghost: "con-btn-ghost",
  danger: "con-btn-danger",
  dangerOutline: "con-btn-danger-outline",
  pos: "con-btn-pos"
};

export function Btn({
  variant = "outline",
  size,
  className,
  type = "button",
  title,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: "sm" }) {
  const button = (
    <button
      type={type}
      className={cx("con-btn", BTN_CLASS[variant], size === "sm" && "con-btn-sm", className)}
      {...rest}
    />
  );
  if (title) {
    return <Tooltip content={title}>{button}</Tooltip>;
  }
  return button;
}

// ── Chip ─────────────────────────────────────────────────────────────────────

export type ChipTone = "muted" | "accent" | "pos" | "neg" | "warn" | "none" | "paper" | "live";

const CHIP_CLASS: Record<ChipTone, string | undefined> = {
  muted: undefined,
  accent: "con-chip-accent",
  pos: "con-chip-pos",
  neg: "con-chip-neg",
  warn: "con-chip-warn",
  none: "con-chip-none",
  paper: "con-chip-paper",
  live: "con-chip-live"
};

export function Chip({ tone = "muted", className, title, children }: { tone?: ChipTone; className?: string; title?: string; children: ReactNode }) {
  const chip = (
    <span className={cx("con-chip", CHIP_CLASS[tone], className)}>
      {children}
    </span>
  );
  // Only pay for the Tooltip (state + effects) when there's actually a title —
  // matches the Btn pattern above and avoids per-chip hook overhead in lists.
  if (title) {
    return <Tooltip content={title}>{chip}</Tooltip>;
  }
  return chip;
}

/** Small brokerage-confirmation tag for actions that still use the server's
 *  typed confirmation contract. Function name stays stable for existing call
 *  sites, but the visible label avoids treating normal brokerage accounts as an
 *  emergency state. */
export function LiveTag() {
  return <span className="con-live-tag">BROKER</span>;
}

// ── Status dot ───────────────────────────────────────────────────────────────

const DOT_COLOR: Record<string, string> = {
  pos: "var(--con-pos)",
  neg: "var(--con-neg)",
  warn: "var(--con-warn)",
  accent: "var(--con-accent)",
  muted: "var(--con-faint)"
};

export function Dot({ tone = "muted", pulse }: { tone?: keyof typeof DOT_COLOR; pulse?: boolean }) {
  return <span className={cx("con-dot", pulse && "con-dot-pulse")} style={{ background: DOT_COLOR[tone] ?? DOT_COLOR.muted }} aria-hidden />;
}

// ── Meter ────────────────────────────────────────────────────────────────────

export function Meter({ value, max, className }: { value: number; max?: number; className?: string }) {
  const hasMax = typeof max === "number" && Number.isFinite(max) && max > 0;
  const ratio = hasMax ? Math.min(1, Math.max(0, value / max!)) : 0;
  const tone = ratio >= 0.95 ? "con-meter-neg" : ratio >= 0.75 ? "con-meter-warn" : undefined;
  return (
    <div className={cx("con-meter", tone, className)} role="progressbar" aria-valuenow={value} aria-valuemax={hasMax ? max : undefined}>
      <div style={{ width: `${hasMax ? ratio * 100 : 0}%` }} />
    </div>
  );
}

// ── Stat (label + big number) ────────────────────────────────────────────────

export function Stat({
  label,
  value,
  sub,
  tone,
  title
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "pos" | "neg" | "muted";
  title?: string;
}) {
  const color = tone === "pos" ? "var(--con-pos)" : tone === "neg" ? "var(--con-neg)" : undefined;
  return (
    <Tooltip content={title} className="block">
      <div>
        <div className="con-card-title">{label}</div>
        <div className="con-num mt-1 text-[length:var(--con-fs-xl)] font-semibold leading-tight" style={color ? { color } : undefined}>
          {value}
        </div>
        {sub !== undefined && <div className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{sub}</div>}
      </div>
    </Tooltip>
  );
}

// ── Form controls ────────────────────────────────────────────────────────────

export function Field({ label, hint, children, htmlFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <label className="con-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">{hint}</p>}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx("con-input", props.className)} />;
}

export function NumInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="number" inputMode="decimal" {...props} className={cx("con-input con-input-num", props.className)} />;
}

/**
 * Controlled numeric input that fixes the "0."-collapse bug: a plain
 * `value={Number(...)}` input re-renders `"0."` or `"12."` back to `"0"`/`"12"`
 * on every keystroke because `Number("0.")` is a whole number, so the trailing
 * `.` (or `-`, or a mid-typed decimal) can never be typed. This component keeps
 * the raw typed text in local state while focused — so those transient strings
 * survive — while still committing the PARSED number to the caller on every
 * keystroke via `onValueChange`. On blur it drops the raw text and snaps back
 * to whatever canonical string the caller derives from its own committed value
 * (`value` prop), matching the commit-on-blur pattern this replaces.
 */
export function RawNumInput({
  value,
  onValueChange,
  emptyValue,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  /** Canonical display value (e.g. `String(current)`), shown whenever not focused. */
  value: string;
  /** Called with the parsed number on every keystroke; NaN/empty becomes `emptyValue`. */
  onValueChange: (parsed: number, raw: string) => void;
  /** Value passed to `onValueChange` when the field is empty or unparsable. */
  emptyValue: number;
}) {
  const [editText, setEditText] = useState<string | null>(null);
  return (
    <NumInput
      {...props}
      value={editText ?? value}
      onFocus={(e) => {
        setEditText(value);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        setEditText(null);
        props.onBlur?.(e);
      }}
      onChange={(e) => {
        const raw = e.target.value;
        setEditText(raw);
        const parsed = Number(raw);
        onValueChange(raw === "" || !Number.isFinite(parsed) ? emptyValue : parsed, raw);
      }}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx("con-select", props.className)} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx("con-textarea", props.className)} />;
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="con-toggle"
      onClick={() => onChange(!checked)}
    />
  );
}

// ── Empty state / dash ───────────────────────────────────────────────────────

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">{children}</p>;
}

export function Dash() {
  return <span className="text-[color:var(--con-faint)]">{EM_DASH}</span>;
}

/** Humanized timestamp with the exact time on hover — the console's rule for
 *  every timestamp. */
export function Ago({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <Dash />;
  return (
    <Tooltip content={fmtExact(iso)}>
      <time dateTime={iso} className="cursor-default whitespace-nowrap">
        {timeAgo(iso)}
      </time>
    </Tooltip>
  );
}

/** Signed value coloring: green up, red down, plain when zero/absent. */
export function signTone(v: number | null | undefined): "pos" | "neg" | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v === 0) return undefined;
  return v > 0 ? "pos" : "neg";
}

export function SignedText({ value, children }: { value: number | null | undefined; children: ReactNode }) {
  const tone = signTone(value);
  const color = tone === "pos" ? "var(--con-pos)" : tone === "neg" ? "var(--con-neg)" : undefined;
  return (
    <span className="con-num" style={color ? { color } : undefined}>
      {children}
    </span>
  );
}

// ── Tooltip ──────────────────────────────────────────────────────────────────

export function Tooltip({
  children,
  content,
  className
}: {
  children: ReactNode;
  content: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  if (!content) return <>{children}</>;

  return (
    <span
      ref={ref}
      className={cx("group relative inline-flex", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      {children}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 2, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 2, scale: 0.98 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            role="tooltip"
            className="pointer-events-none absolute bottom-full left-1/2 z-[100] mb-2 w-max max-w-xs -translate-x-1/2 rounded-[var(--con-radius-sm)] border border-[color:var(--con-line-strong)] bg-[color:var(--con-surface)] px-2.5 py-1.5 text-center text-[length:var(--con-fs-xs)] font-medium leading-snug text-[color:var(--con-fg)] shadow-[var(--con-shadow-lg)]"
          >
            {content}
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );
}

