import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@/": resolve(__dirname, "./src/")
    }
  },
  test: {
    maxWorkers: 4,
    testTimeout: 20_000,
    exclude: [
      "node_modules/**",
      ".next/**",
      ".claude/**",
      ".agents/**",
      ".cursor/**",
      ".codex/**",
      "test/e2e/**",
      "reference/**"
    ]
  }
});
