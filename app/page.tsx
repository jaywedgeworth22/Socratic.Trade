import { headers } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // admin.socratictrade.com lands on the operator admin hub; every other host goes to the console.
  // Inert until ADMIN_HOST is set (e.g. "admin.socratictrade.com"). Auth still applies to /admin.
  const adminHost = process.env.ADMIN_HOST?.trim().toLowerCase();
  if (adminHost) {
    const host = (await headers()).get("host")?.toLowerCase() ?? "";
    if (host === adminHost) redirect("/admin");
  }
  redirect("/console");
}
