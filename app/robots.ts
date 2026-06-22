import type { MetadataRoute } from "next";

const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://trading.jays.services";

export default function robots(): MetadataRoute.Robots {
  // The app is private by default — disallow all crawling unless indexing is explicitly enabled.
  if (process.env.NEXT_PUBLIC_ALLOW_INDEXING !== "true") {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  // Public: only the marketing page is crawlable; the gated app + APIs are not.
  return {
    rules: { userAgent: "*", allow: ["/welcome"], disallow: ["/", "/api/", "/access-denied"] },
    sitemap: `${base}/sitemap.xml`
  };
}
