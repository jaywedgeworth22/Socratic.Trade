import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";

function createRequest(urlStr: string, hostHeader: string): NextRequest {
  return new NextRequest(urlStr, {
    headers: {
      host: hostHeader,
      "user-agent": "test-agent"
    }
  });
}

describe("middleware — subdomain routing for mobile and console", () => {
  it("redirects mobile.socratictrade.com/ to /console (PWA retired)", async () => {
    const req = createRequest("https://mobile.socratictrade.com/", "mobile.socratictrade.com");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://mobile.socratictrade.com/console");
  });

  it("redirects mobile.socratic.trade/settings to /console/settings", async () => {
    const req = createRequest("https://mobile.socratic.trade/settings", "mobile.socratic.trade");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://mobile.socratic.trade/console/settings");
  });

  it("redirects console.socratictrade.com/ to /console", async () => {
    const req = createRequest("https://console.socratictrade.com/", "console.socratictrade.com");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://console.socratictrade.com/console");
  });

  it("redirects console.socratic.trade/usage to /console/usage", async () => {
    const req = createRequest("https://console.socratic.trade/usage", "console.socratic.trade");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://console.socratic.trade/console/usage");
  });

  it("sends leftover /mobile paths on the mobile host to /console", async () => {
    const reqMobile = createRequest("https://mobile.socratictrade.com/mobile", "mobile.socratictrade.com");
    const resMobile = await middleware(reqMobile);
    expect(resMobile.status).toBe(307);
    expect(resMobile.headers.get("location")).toBe("https://mobile.socratictrade.com/console");

    const reqConsole = createRequest("https://console.socratictrade.com/console", "console.socratictrade.com");
    const resConsole = await middleware(reqConsole);
    expect(resConsole.status).not.toBe(307);
  });
});
