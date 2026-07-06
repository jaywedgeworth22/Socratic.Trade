import { StatTile } from "socratic-trade-dashboard";

export const Grid = () => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(140px, 1fr))", gap: 12 }}>
    <StatTile label="Net liquidation" value="$128,430" sub="+$2,140 today" tone="up" />
    <StatTile label="Day P/L" value="-$612" sub="-0.47%" tone="down" />
    <StatTile label="Buying power" value="$41,905" sub="2.1× margin" />
  </div>
);

export const Tones = () => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(160px, 1fr))", gap: 12 }}>
    <StatTile label="Unrealized" value="+18.2%" tone="up" />
    <StatTile label="Drawdown" value="-6.4%" tone="down" />
    <StatTile label="Cash runway" value="94 days" tone="warn" />
    <StatTile label="Open positions" value="7" tone="neutral" />
  </div>
);
