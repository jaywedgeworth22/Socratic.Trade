import { DashboardClient } from "./dashboard-client";
import type { DashboardSnapshot } from "./dashboard-types";
import { getDashboardSnapshot } from "@/lib/dashboard";
import { AUTHENTICATED_EMAIL_HEADER, resolveRequestUserFromEmail } from "@/lib/request-user";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const requestHeaders = await headers();
  const user = resolveRequestUserFromEmail(requestHeaders.get(AUTHENTICATED_EMAIL_HEADER));
  const snapshot = await getDashboardSnapshot(user.userId, user.email);
  // Flight serialization is stricter than JSON and can choke on shared object refs.
  return <DashboardClient initialSnapshot={JSON.parse(JSON.stringify(snapshot)) as DashboardSnapshot} />;
}
