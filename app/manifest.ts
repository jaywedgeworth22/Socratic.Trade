import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Socratic Trade",
    short_name: "Socratic.Trade",
    description: "Phone control surface for Socratic Trade.",
    start_url: "/mobile",
    scope: "/",
    display: "standalone",
    background_color: "#080b12",
    theme_color: "#080b12",
    orientation: "portrait",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable"
      },
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png"
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png"
      }
    ]
  };
}
