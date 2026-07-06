import { Field } from "socratic-trade-dashboard";

// NOTE: `inputClass` is exported from app/ui/primitives.tsx but is NOT re-exported
// by the design-sync bundle entry (.design-sync/ds-src/index.tsx), so
// `import { inputClass } from "socratic-trade-dashboard"` resolves to `undefined`
// at preview-build time (confirmed: rendered <input> had zero classes applied —
// no border/padding/background). Inlined here verbatim as a workaround since
// ds-src/index.tsx is bundle config, not a preview file. See
// .design-sync/learnings/batchB.md.
const inputClass =
  "w-full rounded-lg border border-line bg-bg/60 px-3 py-2 text-sm text-fg outline-none transition-colors placeholder:text-faint focus:border-accent focus:ring-1 focus:ring-accent";

export const MaxPositionSize = () => (
  <div style={{ maxWidth: 320 }}>
    <Field label="Max position size" hint="Percent of buying power allowed in a single position.">
      <input className={inputClass} defaultValue="5%" />
    </Field>
  </div>
);

export const StopLossTrigger = () => (
  <div style={{ maxWidth: 320 }}>
    <Field label="Stop-loss trigger" hint="Closes the position automatically once loss reaches this threshold.">
      <input className={inputClass} defaultValue="-8%" />
    </Field>
  </div>
);

export const TickerSymbol = () => (
  <div style={{ maxWidth: 320 }}>
    <Field label="Ticker symbol">
      <input className={inputClass} defaultValue="NVDA" />
    </Field>
  </div>
);

export const StackedForm = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 320 }}>
    <Field label="Daily notional cap" hint="Maximum total order value the strategy loop can submit per trading day.">
      <input className={inputClass} defaultValue="$25,000" />
    </Field>
    <Field label="Trade thesis tag">
      <input className={inputClass} defaultValue="Earnings drift" />
    </Field>
  </div>
);
