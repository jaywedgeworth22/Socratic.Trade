import type { MetadataRoute } from "next";

const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://trading.jays.services";

export default function sitemap(): MetadataRoute.Sitemap {
  // Only the public marketing page belongs in the sitemap; the app itself is gated.
  return [{ url: `${base}/welcome`, changeFrequency: "monthly", priority: 1 }];
}
