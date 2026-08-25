import { expect, test } from "@playwright/test";

test("dashboard loads the core trading workspace", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  // First-paint budget 30s, not the 10s expect default: the intro shell renders no text until
  // /api/dashboard returns, whose upstreams are deadline-bounded at 4-8s EACH but awaited
  // sequentially (#1293) — 10-25s worst-case first paint on a shared CI runner is legitimate.
  // This test's intent is "app boots and renders", not a first-paint SLA (FLEET-INFRA-K:
  // 11 flakes/5 days were all this line timing out at 10s).
  await expect(page.getByText("Socratic Trade").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Portfolio").first()).toBeVisible();
  await expect(page.getByText("Decision").first()).toBeVisible();

  // Default mobile pins are Home / Proposals / Activity / Orders (MOBILE_TABS_MAX=4).
  // Scan lives in the More sheet. getByText("Scan").first() used to match the desktop
  // rail's hidden <span class="flex-1">Scan</span> on iPhone (lg:hidden rail) and fail
  // toBeVisible — same red on #3090 and the #3096 docs merge. Role queries skip hidden
  // nodes; open More on the phone bar, else assert the visible rail link.
  const more = page.getByRole("button", { name: /^More$/ });
  if (await more.isVisible()) {
    await more.click();
    await expect(page.getByRole("dialog", { name: "More" }).getByRole("link", { name: "Scan" })).toBeVisible();
  } else {
    await expect(page.getByRole("navigation", { name: "Console navigation" }).getByRole("link", { name: "Scan" })).toBeVisible();
  }

  await expect(page.getByRole("button", { name: /Run/i }).first()).toBeVisible();
  // Header kill switch: "Stop" while the system is active, "Start" while halted.
  await expect(page.getByRole("button", { name: /Start|Stop/i }).first()).toBeVisible();
});
