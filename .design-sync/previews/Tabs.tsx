import { Tabs } from "socratic-trade-dashboard";

const dashboardTabs = [
  { id: "positions", label: "Positions" },
  { id: "orders", label: "Orders" },
  { id: "history", label: "History" }
];

export const PositionsActive = () => <Tabs value="positions" onChange={() => {}} tabs={dashboardTabs} />;

export const HistoryActive = () => <Tabs value="history" onChange={() => {}} tabs={dashboardTabs} />;

export const StrategyReviewTabs = () => (
  <Tabs
    value="proposals"
    onChange={() => {}}
    tabs={[
      { id: "proposals", label: "Proposals" },
      { id: "bear-veto", label: "Bear veto" },
      { id: "decision-log", label: "Decision log" }
    ]}
  />
);
