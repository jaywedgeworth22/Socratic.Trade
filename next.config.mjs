import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withSentryConfig } from "@sentry/nextjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: __dirname,
  serverExternalPackages: ["better-sqlite3", "@pinecone-database/pinecone", "voyageai"],
  webpack: (config, { isServer, nextRuntime }) => {
    if (!isServer || nextRuntime === "edge") {
      config.resolve.alias = {
        ...(config.resolve.alias ?? {}),
        "better-sqlite3": false,
        "@pinecone-database/pinecone": false,
        "voyageai": false,
        "node:fs": false,
        "node:path": false,
        "node:crypto": false,
        "node:zlib": false,
        "node:stream": false
      };
      config.resolve.fallback = {
        ...(config.resolve.fallback ?? {}),
        fs: false,
        path: false,
        util: false,
        crypto: false,
        zlib: false,
        stream: false
      };
    }
    return config;
  },
  turbopack: {},
  experimental: {
    serverActions: {
      bodySizeLimit: "1mb"
    }
  }
};

// Sentry build wrapper: injects the client/server/edge config imports and (when a
// build-time SENTRY_AUTH_TOKEN is present) uploads source maps so production stack
// traces are de-minified. With no auth token it is inert — no upload, no events.
// Source-map upload only runs when org + project + authToken are all set.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG || "jays-services",
  project: process.env.SENTRY_PROJECT || "agentic-trading",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Better client stack traces; only matters when source maps are uploaded.
  widenClientFileUpload: true,
  // Quiet during local/dev builds; verbose in CI.
  silent: !process.env.CI
});
