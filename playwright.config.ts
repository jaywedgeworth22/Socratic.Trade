import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT || 4201);
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;
const healthURL = `${baseURL}/api/health`;
const webServerCommand =
  process.env.PLAYWRIGHT_WEB_SERVER_COMMAND || `npm run build && npm run start -- -H 127.0.0.1 -p ${port}`;

// The smoke server is started with `next start` (NODE_ENV=production), so the auth middleware fails
// closed and redirects `/` to `/access-denied` for an unauthenticated request — the dashboard never
// renders. Authenticate the test browser the way production does: trust the Cloudflare-Access email
// header (CF_ACCESS_TRUST_EMAIL_HEADER) on the server, and present that verified-upstream identity on
// every request. The smoke email is also the server's PRIMARY_USER_EMAIL so it passes the allowlist.
const authEmail = process.env.PLAYWRIGHT_AUTH_EMAIL || "smoke-test@agentic.local";

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    extraHTTPHeaders: { "cf-access-authenticated-user-email": authEmail }
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: webServerCommand,
        url: healthURL,
        reuseExistingServer: !process.env.CI,
        // The Coolify CI runner deliberately has low CPU shares so production wins
        // contention; its full Next build can exceed four minutes without being stuck.
        timeout: process.env.CI ? 600_000 : 240_000,
        env: {
          CF_ACCESS_TRUST_EMAIL_HEADER: "1",
          PRIMARY_USER_EMAIL: authEmail,
          // The embedded `npm run build` OOMs at V8's default ~2 GB heap on CI runners
          // (Playwright Smoke failed with "Ineffective mark-compacts near heap limit").
          // Set it here, on the spawned server process, so the limit holds regardless of
          // which workflow env the job runs with (e2e.yml also sets this globally).
          NODE_OPTIONS: "--max-old-space-size=3072",
          // Test-only key: next start runs NODE_ENV=production, and the boot guard
          // (assertEncryptionKeyConfiguredInProduction) refuses to boot without a valid
          // 64-char hex ENCRYPTION_KEY. The smoke DB is throwaway, so a fixed key is fine.
          ENCRYPTION_KEY: "0123456789abcdef".repeat(4)
        }
      },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
