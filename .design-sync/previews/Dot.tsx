import { Dot } from "socratic-trade-dashboard";

export const Tones = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Dot tone="up" />
      <span style={{ fontSize: 13, color: "var(--fg)" }}>Live · broker connected</span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Dot tone="down" />
      <span style={{ fontSize: 13, color: "var(--fg)" }}>Disconnected</span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Dot tone="warn" />
      <span style={{ fontSize: 13, color: "var(--fg)" }}>Degraded feed</span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Dot tone="info" />
      <span style={{ fontSize: 13, color: "var(--fg)" }}>Paper account</span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Dot tone="accent" />
      <span style={{ fontSize: 13, color: "var(--fg)" }}>Strategy running</span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Dot tone="neutral" />
      <span style={{ fontSize: 13, color: "var(--fg)" }}>Idle</span>
    </div>
  </div>
);

export const Pulsing = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Dot tone="up" pulse />
      <span style={{ fontSize: 13, color: "var(--fg)" }}>Live · updated 2s ago</span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Dot tone="warn" pulse />
      <span style={{ fontSize: 13, color: "var(--fg)" }}>Order pending fill</span>
    </div>
  </div>
);
