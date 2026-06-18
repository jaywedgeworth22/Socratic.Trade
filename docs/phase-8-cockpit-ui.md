# Phase 8 - Cockpit UI and Strategy Studio

> **2026-06-16 redesign (branch `ui-redesign`) supersedes the layout below.**
> The cockpit was rebuilt on Tailwind CSS 4 + Recharts + Motion with a
> dark/light theme system. The `react-resizable-panels` shell and the always-on
> bottom drawer are replaced by: a slim command bar, a persistent Portfolio rail
> + a tabbed workspace (Decision / Market Scan / Performance / Strategy), feeds
> in a right slide-over, and modal Settings / Strategy Studio, plus a ⌘K command
> palette and a Recharts learning-loop visualization (P&L by thesis/regime).
> A 2026-06-18 glassmorphism pass then changed the visual treatment without
> changing the core information architecture. See
> `docs/rollouts/2026-06-16-ui-redesign-tailwind.md` and
> `docs/rollouts/2026-06-18-glassmorphism-ui.md`. The sections below describe
> the prior panel-based cockpit and current semantics that still matter.


This phase restructures the dashboard from a long vertical page into a
single-screen trading cockpit. The goal is to make the app usable during active
paper/live supervision without requiring page-level scrolling on a desktop
screen.

## Layout Model

- The desktop app shell uses `height: 100dvh` and three fixed rows: command bar,
  main cockpit, and bottom drawer.
- The main cockpit has three regions: left rail, center workspace, and right
  inspector.
- Page-level scrolling is intentionally disabled on desktop. Long content
  scrolls inside its pane.
- Mobile/tablet breakpoints revert to a single-column layout with normal page
  scrolling.

## User-Facing Tabs

- Center workspace tabs: `Decision`, `Market Scan`, `Performance`, `Strategy`.
- Right inspector tabs: `Operate`, `Risk`, `Profile`.
- Bottom drawer tabs: `Activity`, `Runs`, `Notifications`.

The `Decision` tab remains the default because the app's core value is showing
what the agent recommends or decided, not hiding that output in logs.

## Strategy Studio

Strategy Studio exists in two places:

- A center workspace `Strategy` tab for normal use.
- A command-bar modal for larger editing/review sessions.

It includes:

- editable strategy prompt with autosave
- reset-to-default prompt action
- slider/field controls for high-impact strategy and risk options
- scoring weight controls
- LLM strategy review button
- manual apply flow for suggested strategy/policy changes

LLM-generated strategy updates are advisory only. They do not mutate prompt,
policy, risk, or scoring weights until a human clicks `Apply Reviewed Changes`.
This is intentional: automatically rewriting the trading strategy without a
review gate is unsafe for an agentic trading tool.

## Strategy Tuning API

`POST /api/strategy/tune` gathers:

- active policy and prompt
- recent strategy runs
- recent fills in the active paper/live mode
- current performance summary
- latest market scan and proposal summary when available
- macro context from `src/lib/macro.ts`

When `OPENAI_API_KEY` is configured, the route asks the model for a strict JSON
strategy tuning proposal. Without the key, it returns a transparent local-rules
proposal so the UI path remains testable.

## Alerts and Toasts

Transient errors and command results are shown as a **toast stack anchored to
the bottom-right** (`.toast-stack` / `.toast`), not as a fixed-offset banner.
This was previously a `position: fixed; top: 202px` layer whose hardcoded offset
did not match the real command-bar height and floated over content; bottom-right
anchoring is stable regardless of how the header grid wraps or the body `zoom`.
Result/success toasts auto-dismiss after a few seconds; error toasts persist
until dismissed. Each toast carries an icon and an accessible dismiss button.

## Accessibility

- All dialogs render through a single reusable `Modal` component. It provides
  `role="dialog"`, `aria-modal`, an `aria-label` from the title, focus-on-open
  with focus restoration on close, body scroll-lock, Escape-to-close (a
  document-level listener, so it works even if focus leaves the dialog), and
  backdrop-click-to-close. Size variants are `default`, `narrow` (confirmations),
  and `wide` (Strategy Studio).
- Tab groups use `role="tablist"`/`role="tab"` with `aria-selected`, roving
  `tabIndex`, and Left/Right arrow-key navigation.
- Icon-only buttons carry `aria-label`s; the command-bar layout dropdown exposes
  `aria-haspopup`/`aria-expanded` and closes on Escape.
- A global `:focus-visible` outline makes keyboard focus visible, and
  activity-feed detail rows expand on focus rather than hover-only.

## Styling Conventions

Current cockpit styling lives primarily in `app/globals.css` and Tailwind 4
utility classes, with semantic CSS variables for surface, line, text, status,
and glass effects. Avoid reintroducing large inline style objects or per-component
rgba constants; add reusable variables/classes when a visual rule will be shared
across panels, feeds, popovers, or status chips.

## Display Semantics

- Sentiment values are displayed as explicit chips: `Positive`, `Neutral`, or
  `Negative` with the numeric score.
- Up/down arrows are avoided for sentiment because they look like price
  direction or a buy/sell signal.
- Top status values are kept visible in the command bar: mode, portfolio,
  buying power, autonomy, daily risk, and allowed universe.
- Account switching should always preserve a nearby management path. The
  command-bar account selector includes `Manage Accounts...` so an empty or
  incomplete account list does not strand the user away from Settings.
- Symbol drilldown factor values are normalized 0-100 **factor scores**, not
  signed contribution deltas. Avoid labeling that panel as a waterfall unless
  the UI is changed to show actual weighted contributions around a baseline.

## Verification Expectations

After touching this phase, run:

```bash
npx tsc --noEmit
npm test
npm run build
```

For UI changes, also verify desktop and mobile behavior in a browser:

- desktop: body scroll height should equal viewport height
- mobile: shell overflow should become visible and page-level scrolling should
  return
