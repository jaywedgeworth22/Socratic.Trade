# Visual System — Design Tokens & Scales

> Created 2026-07-01 (audit workstream "Chat F", item F10). Source of truth for
> the app's color, spacing, radius, elevation/blur, and icon-size tokens. Cite
> this doc in future PRs instead of re-deriving values, and update it when you
> add or change a token.

The cockpit's visual language is a small set of **semantic tokens** that flip
between light and dark, plus a handful of **consolidated scales** (elevation,
blur, icon size) introduced to stop ad-hoc drift. Almost everything lives in two
files:

- `app/globals.css` — CSS custom properties (`:root` for light, `.dark` for
  dark), the `@theme inline` bridge that exposes them to Tailwind utilities, and
  the utility classes for the consolidated scales.
- `app/ui/primitives.tsx` — the shared component layer (`Button`, `Card`, `Chip`,
  `Tabs`, `EmptyState`, …) and the `ICON` size constant.

Prefer semantic tokens and primitives over raw hex, raw pixel shadows, or
arbitrary Tailwind bracket values (`bg-[#…]`, `shadow-[…]`, `backdrop-blur-[…]`,
`size={13}`). If a value will be shared across panels/feeds/popovers, add a token
here rather than inlining it.

## Color tokens

Defined in `app/globals.css` and exposed to Tailwind as `bg-*`, `text-*`,
`border-*` utilities via `@theme inline`. Values flip per theme, so the same
markup themes automatically.

| Token | Tailwind | Role |
|-------|----------|------|
| `--bg` | `bg-bg` | App background (behind the glass surfaces). |
| `--surface` / `--surface-2` / `--surface-3` | `bg-surface` / `bg-surface-2` / `bg-surface-3` | Layered translucent glass surfaces (resting → nested). |
| `--line` / `--line-strong` | `border-line` / `border-line-strong` | Hairline borders / stronger dividers & scrollbars. |
| `--fg` | `text-fg` | Primary foreground text. |
| `--muted` | `text-muted` | Secondary text (labels, subtitles). |
| `--faint` | `text-faint` | Tertiary text (hints, meta). |
| `--accent` / `--accent-fg` | `text-accent` / `bg-accent` / `text-accent-fg` | Brand/CTA green + its on-color. |
| `--pos` / `--neg` / `--neg-fg` | `text-pos` / `text-neg` / `text-neg-fg` | Gains / losses (and the loss on-color for danger buttons). |
| `--warn` / `--info` | `text-warn` / `text-info` | Warning / informational status. |
| `--ring` | `focus-visible:ring-[var(--ring)]` | Focus ring. |

Status tones are also wrapped by the `Chip`/`Dot`/`StatTile` primitives
(`neutral | pos | neg | warn | info | accent`) — use those instead of hand-rolling
tinted badges. (Tone vocabulary standardized on `pos/neg` per the 2026-07-05 UI audit,
finding 1.2 — `up/down` collided with price-direction language, and the console system
already used `pos/neg`.)

### WCAG-AA contrast — source of truth

Contrast is guaranteed at the token level, documented inline where the tokens are
defined:

- `app/globals.css:18-19` (light) and `:43-44`/`:55-56` (dark) — `--muted` and
  `--faint` are chosen to meet **4.5:1 (normal text)** on every surface tier.
  Recorded worst cases: **≥7.3:1** on `surface-3` in light mode, **≥5.5:1** on
  `surface-3` in dark mode.
- `--neg-fg` exists specifically so danger buttons pass AA in dark mode
  (`text-white` on `--neg` measured ≈4.07:1, below 4.5:1). History:
  `docs/reviews/2026-06-21-ui-ux-issue-register.md:89` (issue A11Y-7) and
  `docs/reviews/2026-06-20-ui-ux-and-mobile-audit.md:245`.

Rule: `text-faint` is used for **real** labels/table headers, not just decoration,
so any new faint-on-surface combination must still clear 4.5:1. When adding or
retinting a text token, re-check it against `surface-3` (the worst-case
background) in both themes before committing.

## Brand accent (2026-07-08, UI-audit Package G)

The app ships two design systems — `app/ui` (legacy/marketing surfaces) and
`app/console` (the `/console` cockpit) — that previously carried two distinct
brand accents (`app/ui` green `#0e9f6e`/`#10b981`, console teal `#12616f`/
`#58c7d3`). **Console teal is now the single brand accent both systems derive
from**, per `docs/reviews/2026-07-05-ui-audit-and-design-system-unification.md`.

- `app/globals.css` `:root` defines two invariant constants —
  `--brand-accent: #12616f` (light) and `--brand-accent-dark: #58c7d3` (dark).
  They're plain, non-flipping values (not a `:root`/`.dark`-switching pair)
  because `app/console/console.css` themes itself independently via
  `[data-theme]`, not the `.dark` class, so it needs to resolve either one
  directly regardless of ancestor `.dark` state.
- `app/globals.css` `--accent` (light) / `.dark --accent` (dark) now read
  `var(--brand-accent)` / `var(--brand-accent-dark)` — `app/ui`'s accent moved
  green → teal. `--accent-fg` (`#ffffff` light, `#04130d` dark) already clears
  WCAG AA against the new teal (~7.1:1 light, ~9.5:1 dark) — no change needed,
  and it mirrors console's own `--con-accent-contrast` pairing (`#ffffff` /
  `#071316`). `--ring` is now derived (`color-mix(in oklab, var(--accent) …%,
  transparent)`) instead of a hardcoded rgba, so the focus ring always tracks
  brand accent.
- `app/console/console.css` `--con-accent` (light) and both dark blocks now
  read `var(--brand-accent)` / `var(--brand-accent-dark)` — same visual values
  as before, console is simply the canonical source the shared tokens were
  read from. Every `--con-*-soft`/`--con-*-border` derived tint is unaffected
  (they `color-mix` off `--con-accent` already).
- `--accent` stays distinct from `--pos` (gain/green) in both systems by
  design — accent is brand/CTA, not a P&L signal.

## Radius canon (2026-07-08, UI-audit Package G)

Console's card/control radii are canonical. `app/globals.css` `@theme inline`
defines `--radius-card: 12px` and `--radius-control: 8px` (sourced from
console's own `--con-radius`/`--con-radius-sm`), and
`app/console/console.css` maps `--con-radius`/`--con-radius-sm` back to them
so both stay in lockstep. This does **not** retarget `app/ui`'s existing
`rounded-xl`/`rounded-2xl` usage — those are unchanged. Future `app/ui` work
that wants to align with the console radius scale should reach for the new
`rounded-card`/`rounded-control` Tailwind utilities (generated from the
`--radius-card`/`--radius-control` `@theme inline` vars) rather than
`rounded-xl`/`rounded-2xl` or an arbitrary value.

## Radius & typography

- Radius tokens: `--radius-xl: 16px`, `--radius-2xl: 20px` (`@theme inline`),
  surfaced as `rounded-xl` / `rounded-2xl`. Cards use `rounded-2xl`; inputs,
  buttons, chips, and menu items use `rounded-lg`/`rounded-md`. See "Radius
  canon" above for the separate `--radius-card`/`--radius-control` pair
  console.css sources from.
- Fonts: `--font-sans` (Inter) for UI, `--font-mono` (JetBrains Mono) for code.
  Numeric/tabular data uses the `.tnum` helper (`font-variant-numeric:
  tabular-nums`) so digits align in tables.

## Spacing

Spacing follows Tailwind's default 4px scale — there are no custom spacing
tokens. Conventions in use: cards pad `px-4 py-3`/`p-4`; panel headers
`px-4 pt-4`; inter-card gaps `gap-2`/`gap-3`; dense inline gaps `gap-1.5`.
Touch targets honor a `max-sm:min-h-11` (44px) minimum on interactive controls
(buttons, tabs, icon buttons) for mobile accessibility.

## Elevation & blur scale (consolidated 2026-07-01, item F8)

Previously there were only two shadow tiers (`--shadow`, `--shadow-lg`) while
`backdrop-blur` usage had drifted to seven distinct values, including arbitrary
`backdrop-blur-[2px]` / `backdrop-blur-[3px]` that bypassed the Tailwind scale.

A named **3-tier elevation scale** now pairs a shadow with a backdrop-blur per
tier, defined as CSS variables in `app/globals.css` (`:root`) and applied via
utility classes:

| Tier | Class | Shadow var | Blur var | Use |
|------|-------|-----------|----------|-----|
| Surface | `.elev-surface` | `--elev-surface-shadow` (= `--shadow`) | `--elev-surface-blur` (4px) | Resting cards / panels. |
| Raised | `.elev-raised` | `--elev-raised-shadow` (= `--shadow`) | `--elev-raised-blur` (12px) | Popovers, menus, floating chips. |
| Overlay | `.elev-overlay` | `--elev-overlay-shadow` (= `--shadow-lg`) | `--elev-overlay-blur` (40px) | Modals, the command palette. |

The shadow itself still flips light/dark through `--shadow` / `--shadow-lg`, so
the tiers inherit the correct theme automatically without separate light/dark
elevation definitions.

**Scrim.** The dimmed backdrop behind an overlay uses a dedicated
`--blur-scrim: 2px` variable applied via the `.backdrop-blur-scrim` utility. The
two arbitrary bracket blurs (`[2px]` in `overlays.tsx` / `command-palette.tsx`,
`[3px]` in `dashboard-client.tsx`) were migrated onto this single named scrim
tier. **Acceptance:** `grep -rn 'blur-\[' app/` returns nothing.

Existing `shadow-[var(--shadow)]` / `shadow-[var(--shadow-lg)]` and
`backdrop-blur-{sm,md,lg,xl,2xl}` utilities remain valid for one-off surfaces;
prefer the `.elev-*` classes when you want a coordinated shadow+blur pairing.

## Icon size scale (consolidated 2026-07-01, item F9)

Lucide icon `size=` values had drifted to twelve distinct numbers
(10,11,12,13,14,15,16,17,18,20 plus stray 24/28). They are collapsed to a
**3-step scale** exported from `app/ui/primitives.tsx`:

```ts
export const ICON = { sm: 14, md: 16, lg: 20 } as const;
```

| Step | Value | Use |
|------|-------|-----|
| `ICON.sm` | 14 | Inline / dense: chips, table cells, tight button glyphs, "Show more" toggles. |
| `ICON.md` | 16 | Default: buttons, panel-header icons, most controls. |
| `ICON.lg` | 20 | Prominent: modal-header icons, empty-state glyphs. |

Migration mapping applied to the long tail: `10/11/12/13 → 14`, `15/17 → 16`,
`18/24/28 → 20`. New code should reference `ICON.sm|md|lg` rather than a literal.

**Out of scope:** `app/ui/strategy-flow.tsx`'s `<Background … size={1}>` is a
React-Flow dot-grid prop, **not** an icon — leave it. **Acceptance:**
`grep -ohE 'size=\{?[0-9]+\}?' app/*.tsx app/ui/*.tsx` (excluding that Background
prop) shows at most three distinct values (14, 16, 20).

## Primitives & empty/loading states

Reuse the shared primitives instead of re-implementing their look:

- **Empty states:** `EmptyState` (`app/ui/primitives.tsx`) — icon + title +
  optional hint, centered. Used app-wide; do not hand-roll bare `<p>No data</p>`
  placeholders.
- **Loading skeletons:** the `.skeleton` class (`app/globals.css`) — a shimmering
  placeholder with a `prefers-reduced-motion` variant that disables the shimmer.
  Compose it as sized boxes (`h-*`, `w-*`, `rounded`) that mirror the real
  content's shape while data loads.

## Motion & accessibility notes

- A global `:focus-visible` outline plus `focus-visible:ring-[var(--ring)]` makes
  keyboard focus visible on all interactive primitives.
- `@media (prefers-reduced-motion: reduce)` disables the background orbs, the
  `.skeleton` shimmer, the boot strip, and the fast pulse.
- Tab groups use `role="tablist"`/`role="tab"` with `aria-selected` and roving
  `tabIndex` (the `Tabs` primitive). The workspace **"More" overflow** for
  Macro/Tax keeps `role="tab"`/`aria-selected` on its items so an active overflow
  tab is still announced correctly.
- iOS zoom is prevented by forcing 16px form-control font size below `sm`, and
  safe-area insets are applied via `env(safe-area-inset-*)`.

## Related docs

- `docs/phase-8-cockpit-ui.md` — cockpit information architecture, tab lists,
  display semantics, and accessibility expectations.
- `docs/reviews/2026-06-30-improvement-audit.md` — the audit that flagged the
  drifted scales (dimension 6.6, "Aesthetic appeal") this doc consolidates.
