import { ServerMetricsClient } from "./server-metrics-client";

export const metadata = {
  title: "Server & infrastructure metrics — Socratic Trade"
};

export default function ServerMetricsPage() {
  return <ServerMetricsClient />;
}
