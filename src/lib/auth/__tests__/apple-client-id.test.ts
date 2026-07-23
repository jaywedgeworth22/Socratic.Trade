import { describe, expect, it } from "vitest";
import {
  NATIVE_APPLE_CLIENT_ID,
  resolveAppleClientId
} from "../apple-client-id";

describe("resolveAppleClientId", () => {
  it("defaults to the registered native bundle identifier", () => {
    expect(resolveAppleClientId(undefined)).toBe("trade.socratic.app");
    expect(NATIVE_APPLE_CLIENT_ID).toBe("trade.socratic.app");
  });

  it("accepts a nonblank deployment override", () => {
    expect(resolveAppleClientId("  staged.service.id  ")).toBe("staged.service.id");
  });

  it("treats a blank deployment value as unset", () => {
    expect(resolveAppleClientId("   ")).toBe(NATIVE_APPLE_CLIENT_ID);
  });
});
