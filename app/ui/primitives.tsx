"use client";

import { cn } from "./cn";

/* ── Button ──────────────────────────────────────────────────────────────── */
type ButtonVariant = "primary" | "ghost" | "subtle" | "danger" | "accentSoft";
type ButtonSize = "sm" | "md";

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors touch-manipulation disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:brightness-110 shadow-sm",
  danger: "bg-down text-down-fg hover:brightness-110 shadow-sm",
  ghost: "border border-line bg-surface text-fg hover:bg-surface-2",
  subtle: "bg-surface-2 text-fg hover:bg-surface-3",
  accentSoft: "bg-accent/12 text-accent hover:bg-accent/20 border border-accent/20"
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-8 max-sm:min-h-11 px-3 text-[13px]",
  md: "h-10 max-sm:min-h-11 px-4 text-sm"
};

/** Button styling as a class string, for when you need button looks on a non-button
 *  element (e.g. an `<a>` link) without nesting a `<button>` inside an `<a>`. */
export function buttonClass(opts: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) {
  const { variant = "primary", size = "md", className } = opts;
  return cn(buttonBase, buttonVariants[variant], buttonSizes[size], className);
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button className={buttonClass({ variant, size, className })} {...props} />;
}

export function IconButton({
  className,
  label,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-9 w-9 max-sm:h-11 max-sm:w-11 touch-manipulation items-center justify-center rounded-lg border border-line bg-surface text-muted transition-colors hover:text-fg hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2",
        className
      )}
      {...props}
    />
  );
}

/* ── Card / Panel ────────────────────────────────────────────────────────── */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-2xl border border-line bg-surface/80 backdrop-blur-sm", className)}
      {...props}
    />
  );
}

export function PanelHeader({
  title,
  subtitle,
  icon,
  actions,
  className
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3 px-4 pt-4", className)}>
      <div className="flex items-start gap-2.5 min-w-0">
        {icon && <span className="mt-0.5 text-muted">{icon}</span>}
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-faint">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

/* ── Chip / Badge ────────────────────────────────────────────────────────── */
type Tone = "neutral" | "up" | "down" | "warn" | "info" | "accent";
const toneClasses: Record<Tone, string> = {
  neutral: "bg-surface-3 text-muted",
  up: "bg-up/15 text-up",
  down: "bg-down/15 text-down",
  warn: "bg-warn/15 text-warn",
  info: "bg-info/15 text-info",
  accent: "bg-accent/15 text-accent"
};

export function Chip({
  tone = "neutral",
  className,
  children
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap",
        toneClasses[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone = "up", pulse }: { tone?: Tone; pulse?: boolean }) {
  const color = { up: "bg-up", down: "bg-down", warn: "bg-warn", info: "bg-info", accent: "bg-accent", neutral: "bg-faint" }[tone];
  return (
    <span className="relative flex h-2 w-2">
      {pulse && <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-70", color)} />}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", color)} />
    </span>
  );
}

/* ── Switch / Segmented ──────────────────────────────────────────────────── */
export function Switch({
  checked,
  onChange,
  label
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2",
        checked ? "bg-accent" : "bg-surface-3"
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-6" : "translate-x-1"
        )}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  buttonClassName
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; tone?: Tone; title?: string }>;
  className?: string;
  buttonClassName?: string;
}) {
  return (
    <div className={cn("inline-flex items-center rounded-lg border border-line bg-surface p-0.5", className)}>
      {options.map((opt) => {
        const active = value === opt.value;
        const activeTone =
          opt.tone === "down" ? "bg-down/20 text-down" : opt.tone === "warn" ? "bg-warn/20 text-warn" : "bg-surface-3 text-fg";
        return (
          <button
            key={opt.value}
            type="button"
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded-md px-3 py-1 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
              active ? activeTone : "text-muted hover:text-fg",
              buttonClassName
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Tabs ────────────────────────────────────────────────────────────────── */
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  className,
  tabClassName
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: Array<{ id: T; label: string }>;
  className?: string;
  tabClassName?: string;
}) {
  return (
    <div role="tablist" className={cn("inline-flex items-center gap-1 rounded-xl border border-line bg-surface p-1", className)}>
      {tabs.map((tab, index) => {
        const active = value === tab.id;
        return (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            role="tab"
            aria-selected={active}
            aria-controls={`tabpanel-${tab.id}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                const delta = e.key === "ArrowRight" ? 1 : -1;
                onChange(tabs[(index + delta + tabs.length) % tabs.length].id);
              }
            }}
            className={cn(
              "rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors touch-manipulation max-sm:min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
              active ? "bg-surface-3 text-fg shadow-sm" : "text-muted hover:text-fg",
              tabClassName
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Form field ──────────────────────────────────────────────────────────── */
export function Field({
  label,
  hint,
  children,
  className
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block space-y-1.5", className)}>
      <span className="block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs text-faint">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-line bg-bg/60 px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-faint focus:border-accent focus:ring-1 focus:ring-accent";

export function StatTile({
  label,
  value,
  sub,
  tone = "neutral",
  icon,
  title
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: Tone;
  icon?: React.ReactNode;
  /**
   * Native hover tooltip for the whole tile — used to carry the value's provenance
   * (source + "Received HH:MM"). Applied to the tile's container `Card` below so hovering
   * anywhere on the tile reveals it. Pass a `dataPointTitle(...)` string only when a real
   * source/time is known; leave undefined to fall back to no tooltip rather than fabricating one.
   */
  title?: string;
}) {
  const valueTone = tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-warn" : "text-fg";
  return (
    <Card className="px-4 py-3" title={title}>
      <div className="flex items-center justify-between text-muted">
        <span className="text-[11px] font-semibold uppercase tracking-wide">{label}</span>
        {icon && <span className="text-faint">{icon}</span>}
      </div>
      <div className={cn("mt-1.5 text-xl tnum leading-none", valueTone)}>{value}</div>
      {sub && <div className="mt-1 text-[11px] text-faint">{sub}</div>}
    </Card>
  );
}

export function EmptyState({ icon, title, hint }: { icon?: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon && <span className="text-faint">{icon}</span>}
      <p className="text-sm font-medium text-muted">{title}</p>
      {hint && <p className="max-w-sm text-xs text-faint">{hint}</p>}
    </div>
  );
}
