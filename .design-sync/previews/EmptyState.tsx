import { EmptyState } from "socratic-trade-dashboard";
import { Inbox, Sparkles, Search } from "lucide-react";

export const NoOpenPositions = () => (
  <div style={{ maxWidth: 360, border: "1px solid var(--line)", borderRadius: 16 }}>
    <EmptyState
      icon={<Inbox size={20} />}
      title="No open positions"
      hint="Positions will appear here once an order fills."
    />
  </div>
);

export const NoProposalsYet = () => (
  <div style={{ maxWidth: 360, border: "1px solid var(--line)", borderRadius: 16 }}>
    <EmptyState
      icon={<Sparkles size={20} />}
      title="No trade proposals yet"
      hint="Run the strategy loop to generate ideas from the current watchlist."
    />
  </div>
);

export const NoMatchingSymbols = () => (
  <div style={{ maxWidth: 360, border: "1px solid var(--line)", borderRadius: 16 }}>
    <EmptyState icon={<Search size={20} />} title="No symbols match your filters" />
  </div>
);
