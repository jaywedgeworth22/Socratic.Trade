import { Segmented } from "socratic-trade-dashboard";

export const OrderSideBuyActive = () => (
  <Segmented
    value="buy"
    onChange={() => {}}
    options={[
      { value: "buy", label: "Buy" },
      { value: "sell", label: "Sell", tone: "down" },
      { value: "short", label: "Short", tone: "down" },
      { value: "cover", label: "Cover" }
    ]}
  />
);

export const OrderSideSellActive = () => (
  <Segmented
    value="sell"
    onChange={() => {}}
    options={[
      { value: "buy", label: "Buy" },
      { value: "sell", label: "Sell", tone: "down" },
      { value: "short", label: "Short", tone: "down" },
      { value: "cover", label: "Cover" }
    ]}
  />
);

export const Timeframe = () => (
  <Segmented
    value="1M"
    onChange={() => {}}
    options={[
      { value: "1D", label: "1D" },
      { value: "1W", label: "1W" },
      { value: "1M", label: "1M" },
      { value: "1Y", label: "1Y" }
    ]}
  />
);

export const RiskTone = () => (
  <Segmented
    value="high"
    onChange={() => {}}
    options={[
      { value: "low", label: "Low risk" },
      { value: "med", label: "Medium risk", title: "Standard position sizing" },
      { value: "high", label: "High risk", tone: "warn", title: "Requires manual approval" }
    ]}
  />
);
