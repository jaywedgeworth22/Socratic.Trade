import { DashboardClient } from "./dashboard-client";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  return <DashboardClient initialSnapshot={null} />;
}
