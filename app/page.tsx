import { DashboardClient } from "./dashboard-client";
import type { DashboardSnapshot } from "./dashboard-types";
import { getDashboardSnapshot } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const snapshot = await getDashboardSnapshot();
  // Flight serialization is stricter than JSON and can choke on shared object refs.
  return <DashboardClient initialSnapshot={JSON.parse(JSON.stringify(snapshot)) as DashboardSnapshot} />;
}
