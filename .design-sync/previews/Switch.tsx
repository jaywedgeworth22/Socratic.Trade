import { Switch } from "socratic-trade-dashboard";

export const AutonomousExecution = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Switch checked={true} onChange={() => {}} label="Autonomous execution" />
      <span style={{ fontSize: 13, color: "var(--fg)" }}>Autonomous execution — enabled</span>
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Switch checked={false} onChange={() => {}} label="Autonomous execution" />
      <span style={{ fontSize: 13, color: "var(--fg)" }}>Autonomous execution — disabled</span>
    </div>
  </div>
);

export const PolicyToggles = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 320 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <span style={{ fontSize: 13, color: "var(--fg)" }}>Extended-hours trading</span>
      <Switch checked={false} onChange={() => {}} label="Extended-hours trading" />
    </div>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <span style={{ fontSize: 13, color: "var(--fg)" }}>Disregard IRA wash-sale guard</span>
      <Switch checked={true} onChange={() => {}} label="Disregard IRA wash-sale guard" />
    </div>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <span style={{ fontSize: 13, color: "var(--fg)" }}>Notify on every fill</span>
      <Switch checked={true} onChange={() => {}} label="Notify on every fill" />
    </div>
  </div>
);
