# Context & Objective
The user requested a number of layout and casing refinements to the Console UI. This includes compressing the `PositionsCard` mobile layout from 6 lines to a strict 3-line format, standardizing casing across triage dropdowns and bulk-action buttons (to fully lower-case or specific Title Case per user direction), and aligning the disclosure components (e.g. `<details>` and `<summary>`) in Safari to prevent flexbox rendering issues.

# Changes Made
- **PositionsCard (`app/console/components/positions.tsx`)**: Refactored the `lg:hidden` layout to be exactly 3 lines using flexbox, consolidating symbol, quantity, value, protection, P&L, and weight with proper spacing and text coloring.
- **Triage Casing (`app/console/approvals/page.tsx`)**: Ensured all bulk action buttons (`approve selected`, `reject selected`, `select visible`) use consistent all-lowercase styling as directed. Dropdown options (`all ideas`, `newest first`) are also appropriately lowercase.
- **Safari Disclosures (`app/console/console.css`, `app/console/ui/primitives.tsx`, `app/console/ui/drilldown-sections.tsx`, `app/console/strategy/page.tsx`)**: Replaced `flex` on `<summary>` tags with a wrapping `<summary className="block ...">` to fix Safari bounding-box overflow issues, standardizing the UI with custom `EXPAND` and `COLLAPSE` labels and matching chevrons.
- **Type Issue Fix (`src/lib/congress-share.ts`)**: Removed references to `TradeEventRowSchema` and `trades` fields which were throwing TypeScript compilation errors as they do not exist in the `@jaywedgeworth22/congress-trading-shared` package.

# Decisions & Trade-offs
- The 3-line `PositionsCard` layout removes the grid and relies heavily on `flex` and `whitespace-nowrap` to enforce line constraints on mobile devices without overflowing.
- `TradeEventRowSchema` removal in `congress-share.ts`: A recent shared package bump likely removed or failed to export this type, so it was patched out of the share payload locally to fix the build blocker.

# Verification State
- `bash scripts/land.sh` executed to compile and verify all changes.
- Build passes, `tsc` check passes.

# Next Steps & Blockers
- None at this time.
