# 2026-06-16 - ui-optimization-pass

## Summary

A prioritized cockpit-UI optimization pass focused on a real rendering bug,
accessibility, and code-quality/maintainability. No backend, API, policy, or
data behavior changed — this is presentation-layer only.

Highest-impact first:

1. **Fixed the floating alert bug.** `.cockpit-alerts` was `position: fixed;
   top: 202px` — a hardcoded magic offset that did not track the real command-bar
   height (~133px) and broke whenever the header grid wrapped, so errors/results
   floated over content. Replaced with a dismissible **toast stack anchored
   bottom-right** (`.toast-stack` / `.toast`), stable under the body `zoom`.
   Success/result toasts auto-dismiss after 6s; errors persist until dismissed.
   Each toast has an icon and an accessible dismiss button.
2. **Accessibility.**
   - Introduced one reusable `Modal` component and migrated all five ad-hoc
     modals (daily limits, Strategy Studio, alert, kill-switch confirm, webhook
     settings) to it. Modals now support **Escape-to-close (document-level, so it
     works regardless of focus), backdrop-click-to-close, focus-on-open +
     focus-restore-on-close, body scroll-lock**, and `role="dialog"`/
     `aria-modal`/`aria-label`. Close buttons use an icon with an `aria-label`.
   - `TabBar` now renders `role="tablist"`/`role="tab"` with `aria-selected`,
     roving `tabIndex`, and Left/Right arrow-key navigation.
   - Layout dropdown gets `aria-haspopup`/`aria-expanded` and closes on Escape.
   - Global `:focus-visible` outline for keyboard users.
   - Activity-detail rows expand on keyboard focus, not hover-only.
3. **Extracted ~400 lines of inline styles to CSS classes** in the Activity Feed
   (group rows, status pills, tags, expanded timeline), the market-scan
   column-settings popover, the filter bar (`.filter-chip`), and the layout menu.
   Status pills reuse a single class family instead of re-deriving rgba colors
   inline.
4. **Removed dead code.** Unused `TradeRow` and `nextRunLabel` functions, the
   unused `scanQuoteAsOf` and `FillEvent` imports (`dashboard-client.tsx`), the
   unused `formatShareQuantity` import (`dashboard-widgets.tsx`), and a block of
   orphaned CSS left over from the pre-cockpit vertical layout (`.shell`,
   `.topbar`, `.band`/`.columns`, `.status-grid*`, `.risk-grid`, `.alloc-wrap`/
   `.alloc-bar`, `.notification-row`/`.notification-copy`/`.notification-time`/
   `.dot-muted`, `.scan-tickers`, `.prompt-head`, bare `.audit`, `.strategy-modal`)
   plus their now-dead `@media` references.
5. **Polish.** Refresh icon spins while busy; modal footers gained spacing;
   confirm-dialog button order is Cancel-then-primary.

## Why

- The fixed-offset alert layer was an actual positioning bug, not just a style
  nit — it is the highest-value fix in this pass.
- The cockpit is a supervision surface; keyboard/Escape/focus handling and
  screen-reader semantics were missing across every modal and tab group.
- The Activity Feed and a few popovers carried large inline-style blocks that
  diverged from the rest of the class-based stylesheet and re-implemented the
  shared status-badge styling, which is a maintenance and consistency hazard.

## Files

- `app/dashboard-client.tsx` — `Modal` component; toast stack + auto-dismiss
  effect; accessible `TabBar`; layout-menu/activity-feed/column-settings
  refactors; dead-code removal.
- `app/dashboard-widgets.tsx` — removed unused `formatShareQuantity` import.
- `app/styles.css` — toast styles, modal size variants + scroll/Escape-friendly
  body, focus-visible, spinner, icon-button, layout-menu, filter-bar, activity
  feed/timeline, column-settings classes; removed orphaned legacy selectors.

## Verification

Ran in order, all green:

```bash
npx tsc --noEmit   # no errors
npm test           # 80 passed (11 files)
npm run build      # succeeded; route / = 31.7 kB / 134 kB First Load JS
```

Browser verification (Next.js dev server via preview tool, 1440x900):

- Strategy Studio modal: `role="dialog"`, `aria-modal="true"`,
  `aria-label="Strategy Studio"`, focus moves inside on open, body overflow
  locked, fits viewport (`modal-wide`).
- Escape closes the modal (document-level handler) and restores body scroll +
  prior focus.
- Activity Feed renders 50 groups + 11 filter chips; policy-change item gets the
  blue left accent; status pill maps to the correct class.
- Toast stack renders bottom-right with red/blue accents, icons, and dismiss
  buttons (verified via an injected sample, then removed).
- Layout dropdown opens with `aria-expanded="true"` and the four panel toggles.

## Post-review fixes

A multi-agent review of this diff (4 dimension reviewers + adversarial
verification of every finding) confirmed **no regressions** and that the change
is safe to merge. It surfaced 8 raw findings; adversarial verification dismissed
6 (with reasoning) and confirmed 2 minor accessibility refinements, plus one
nit. All three were fixed in this pass:

1. **Modal focus trap (confirmed, minor).** `aria-modal` was set but Tab could
   leave the dialog. The Modal's keydown effect now traps Tab/Shift+Tab,
   wrapping focus between the first and last focusable element (verified live:
   forward Tab from the last control wraps to the first and vice-versa; focus
   never leaves the dialog).
2. **Layout menu ARIA (confirmed, minor).** The dropdown was given `role="menu"`
   but its children are bare checkboxes, which is invalid ARIA. Changed to
   `role="group"` + `aria-label="Visible panels"` to match the actual
   checkbox-list nature of the control.
3. **Dead `wrapValue` prop (nit).** The `Metric` widget still appended a
   `metric-wrap-value` class whose CSS rule was removed with the old
   `.status-grid-8` system. The prop was never passed `true` anywhere, so it was
   removed entirely from the component.

## Follow-ups

- The body still uses `zoom: 0.9` for density. It is load-bearing for the dense
  one-viewport layout, so it was left in place; the alert positioning that
  depended on it is now fixed. A future pass could migrate density to a rem/scale
  system and drop `zoom` to remove residual subpixel softness.
- Strategy tuning tests and pane-density polish from Phase 8 remain open
  (unchanged by this pass).
</content>
</invoke>
