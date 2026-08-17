import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

function read(rel: string): Buffer {
  return readFileSync(resolve(rel));
}

function pngHeader(buf: Buffer): { width: number; height: number; colorType: number } {
  expect(buf.toString("ascii", 1, 4)).toBe("PNG");
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colorType: buf[25]
  };
}

const APP_ICON = "ios/SocraticTrade/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png";

describe("website favicon ST crop", () => {
  it("ships a transparent cropped PNG of the offset ST", () => {
    const favicon = pngHeader(read("public/icon.png"));
    expect(favicon).toEqual({ width: 512, height: 512, colorType: 6 });
    expect(pngHeader(read("public/icons/icon-512.png"))).toEqual({ width: 512, height: 512, colorType: 6 });
    expect(pngHeader(read("public/icons/icon-192.png"))).toEqual({ width: 192, height: 192, colorType: 6 });
    expect(pngHeader(read("public/icons/apple-touch-icon-180.png"))).toEqual({
      width: 180,
      height: 180,
      colorType: 6
    });
  });

  it("leaves the iOS App Icon as the opaque 1024 offset ST", () => {
    const appIcon = read(APP_ICON);
    expect(pngHeader(appIcon)).toEqual({ width: 1024, height: 1024, colorType: 2 });
    expect(createHash("md5").update(appIcon).digest("hex")).toBe("46703def33604e89c127cfbaeafff1f0");
  });

  it("reads the App Icon and never writes it", () => {
    const generator = read("scripts/generate-favicon-st.mjs").toString("utf8");
    const raster = read("scripts/generate-pwa-icons.mjs").toString("utf8");
    expect(generator).toContain("never writes the App Icon file");
    expect(generator).toContain("AppIcon-1024.png");
    expect(raster).toMatch(/must not write the iOS App Icon/);
    expect(raster).not.toMatch(/file:\s*["']AppIcon-1024/);
    expect(raster).toContain("websitePngTargets");
  });
});
