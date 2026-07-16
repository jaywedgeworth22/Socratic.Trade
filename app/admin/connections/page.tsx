import { ConnectionsHealthClient } from "./connections-health-client";

export const metadata = { title: "API connections" };

export default function ConnectionsPage() {
  return <ConnectionsHealthClient />;
}
