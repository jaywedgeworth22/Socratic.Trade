import { describe, expect, it } from "vitest";
import { DEFAULT_REQUEST_USER_ID, resolveRequestUserId } from "../src/lib/request-user";

describe("resolveRequestUserId", () => {
  it("defaults to the local user when a request has no user hint", () => {
    expect(resolveRequestUserId(new Request("http://localhost/api/dashboard"))).toBe(DEFAULT_REQUEST_USER_ID);
  });

  it("resolves the x-user-id header before other request hints", () => {
    const request = new Request("http://localhost/api/dashboard?userId=query-user", {
      headers: { "x-user-id": " header-user " }
    });

    expect(resolveRequestUserId(request, { userId: "body-user" })).toBe("header-user");
  });

  it("resolves the userId query parameter when no header is present", () => {
    const request = new Request("http://localhost/api/keys?userId=query-user");

    expect(resolveRequestUserId(request)).toBe("query-user");
  });

  it("resolves an optional body userId when header and query hints are absent", () => {
    const request = new Request("http://localhost/api/keys", { method: "POST" });

    expect(resolveRequestUserId(request, { userId: "body-user" })).toBe("body-user");
  });

  it("ignores empty user hints and falls back to local", () => {
    const request = new Request("http://localhost/api/keys?userId=%20", {
      headers: { "x-user-id": " " }
    });

    expect(resolveRequestUserId(request, { userId: "" })).toBe(DEFAULT_REQUEST_USER_ID);
  });
});
