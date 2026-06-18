import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

export default nextConfig;
