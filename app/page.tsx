import { DashboardClient } from "./dashboard-client";
import type { DashboardSnapshot } from "./dashboard-types";
import { getDashboardSnapshot } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  return <DashboardClient initialSnapshot={(await getDashboardSnapshot()) as DashboardSnapshot} />;
}
