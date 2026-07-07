import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// The legacy dashboard is retired. The Socratic console is the primary (and only) app, so /old now
// redirects there. app/dashboard-client.tsx is kept on disk but unreachable — a separate PR removes
// it and ports-or-drops its two console-absent pieces (the Strategy Flow visualizer and the ⌘K
// command palette). Redirecting also stops /old from bypassing the owner's requireTypedConfirmation
// preference, which the legacy client hardcodes and never reads.
export default async function OldDashboardPage() {
  redirect("/console");
}
