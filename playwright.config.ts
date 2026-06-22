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
        timeout: 240_000,
        env: {
          CF_ACCESS_TRUST_EMAIL_HEADER: "1",
          PRIMARY_USER_EMAIL: authEmail
        }
      },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
