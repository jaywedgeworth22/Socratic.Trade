import { Chip } from "socratic-trade-dashboard";

export const Tones = () => (
  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
    <Chip tone="neutral">Watching</Chip>
    <Chip tone="up">+4.2%</Chip>
    <Chip tone="down">-1.9%</Chip>
    <Chip tone="warn">Earnings risk</Chip>
    <Chip tone="info">Momentum</Chip>
    <Chip tone="accent">Bear veto</Chip>
  </div>
);

export const OrderContext = () => (
  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
    <Chip tone="up">Filled</Chip>
    <Chip tone="warn">Pending</Chip>
    <Chip tone="down">Rejected</Chip>
    <Chip tone="neutral">Cancelled</Chip>
  </div>
);

export const InTickerRow = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 13, fontWeight: 600, width: 56 }}>NVDA</span>
      <Chip tone="up">+4.2%</Chip>
      <Chip tone="accent">Long thesis</Chip>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 13, fontWeight: 600, width: 56 }}>AAPL</span>
      <Chip tone="down">-1.1%</Chip>
      <Chip tone="warn">IV crush risk</Chip>
    </div>
  </div>
);
