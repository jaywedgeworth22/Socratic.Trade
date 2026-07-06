import { PanelHeader, IconButton, Chip } from "socratic-trade-dashboard";
import { LineChart, Settings, RefreshCw } from "lucide-react";

export const Basic = () => (
  <div style={{ width: 360, border: "1px solid var(--line)", borderRadius: 16, background: "var(--surface)", paddingBottom: 16 }}>
    <PanelHeader title="Market scan" subtitle="Updated 30s ago" />
  </div>
);

export const WithIconAndActions = () => (
  <div style={{ width: 360, border: "1px solid var(--line)", borderRadius: 16, background: "var(--surface)", paddingBottom: 16 }}>
    <PanelHeader
      title="Watchlist"
      subtitle="7 symbols · live quotes"
      icon={<LineChart size={16} />}
      actions={
        <>
          <IconButton label="Refresh quotes">
            <RefreshCw size={16} />
          </IconButton>
          <IconButton label="Settings">
            <Settings size={16} />
          </IconButton>
        </>
      }
    />
  </div>
);

export const WithChipActions = () => (
  <div style={{ width: 380, border: "1px solid var(--line)", borderRadius: 16, background: "var(--surface)", paddingBottom: 16 }}>
    <PanelHeader
      title="Open positions"
      subtitle="Net liquidation $128,430"
      actions={<Chip tone="up">+1.8% today</Chip>}
    />
  </div>
);
