import { notFound, redirect } from "next/navigation";

// NAV_V2 PR #5: the public explainer was renamed /strategy → /how-it-works.
// `/strategy` is kept as a redirect shim. Gap #2 resolution: the redirect itself
// is gated by LANDING_PAGE_ENABLED — when the landing page is disabled, this path
// 404s (rather than redirecting to a page that would also 404), so both paths are
// consistently unreachable. The old canonical/OG metadata now lives on
// /how-it-works.
export default function StrategyRedirectPage() {
  if (process.env.LANDING_PAGE_ENABLED !== "true") notFound();
  redirect("/how-it-works");
}
