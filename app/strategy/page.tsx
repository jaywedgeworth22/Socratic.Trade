import { redirect } from "next/navigation";

// NAV_V2 PR #5: the public explainer was renamed /strategy → /how-it-works.
// `/strategy` is kept as a redirect shim. The old canonical/OG metadata now lives
// on /how-it-works.
export default function StrategyRedirectPage() {
  redirect("/how-it-works");
}
