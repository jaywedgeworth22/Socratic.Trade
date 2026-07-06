# Socratic Trade design system

Two independent primitive sets ship in one bundle — pick by surface:

- **UI** (group `ui`) — the main app kit. Tailwind utility classes over semantic CSS-variable
  tokens. Render at the document root; light theme by default. For dark mode, wrap a subtree in
  an element with `className="dark"` (the tokens flip automatically).
- **Console** (group `console`, every export prefixed **`Con*`**) — the `/console` operator kit.
  Bespoke `con-*` classes. **Every console component MUST be rendered inside an element with
  `className="console-root"`** — its tokens (`--con-*`) and component classes only resolve there.
  Without that wrapper, console components render unstyled. Console dark mode: set
  `data-theme="dark"` on the `.console-root` element.

Import both from the package name. The `Con*` prefix is the only naming difference from the app
source (e.g. `ConCard` is the console `Card`, `ConBtn` the console `Btn`).

## Styling idiom

**UI set — Tailwind utilities mapped to semantic tokens.** Never hardcode hex; use these token
utilities so theming works automatically:

- Surfaces: `bg-bg`, `bg-surface`, `bg-surface-2`, `bg-surface-3`
- Text: `text-fg` (primary), `text-muted`, `text-faint`
- Borders: `border-line`, `border-line-strong`
- Accent / semantic: `bg-accent` · `text-accent` · `text-accent-fg`; `text-up` / `bg-up` (gains, green);
  `text-down` / `bg-down` (losses, red); `text-warn`; `text-info`
- Focus ring: `focus-visible:ring-[var(--ring)]`

Compose DS-styled text inputs with the exported `inputClass` string; button-looking links with
`buttonClass({ variant, size })`. Icon sizing: `ICON.sm|md|lg` (14/16/20) with `lucide-react`.

**Console set — bespoke `con-*` classes (inside `.console-root`).** The components apply their own
classes; you don't add token utilities to them. For your own layout around them, plain Tailwind
layout utilities (`flex`, `gap-*`, `px-*`) work anywhere. Classes the components use:
`con-card` / `con-card-title`; `con-btn` + `con-btn-{primary,pos,outline,ghost,danger,danger-outline}`;
`con-chip` + `con-chip-{accent,pos,neg,warn,none,paper,live}`; `con-input` / `con-select` /
`con-textarea`; `con-toggle`; `con-meter`; `con-dot`; `con-num` (tabular figures).

## Where the truth lives

- `styles.css` (which `@import`s `_ds_bundle.css`) — the compiled stylesheet: token definitions
  (`:root` / `.dark` / `.console-root`) plus every utility and `con-*` class. Grep it to confirm a
  token or class exists before using it.
- `components/<group>/<Name>/<Name>.prompt.md` — per-component usage; `<Name>.d.ts` — prop contract.

## Build snippet

```tsx
import { Card, StatTile, Button, ConBtn } from "socratic-trade-dashboard";

// UI surface — document root, semantic tokens via utilities
<Card className="p-4 space-y-3">
  <div className="grid grid-cols-3 gap-3">
    <StatTile label="Net liquidation" value="$128,430" sub="+$2,140 today" tone="up" />
    <StatTile label="Day P/L" value="-$612" tone="down" />
    <StatTile label="Buying power" value="$41,905" />
  </div>
  <Button variant="primary">Place order</Button>
</Card>

// Console surface — MUST wrap in .console-root
<div className="console-root">
  <ConBtn variant="pos">Approve buy</ConBtn>
</div>
```
