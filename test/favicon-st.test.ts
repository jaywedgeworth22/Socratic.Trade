import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import sharp from "sharp";

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

async function transparentShare(rel: string): Promise<number> {
  const { data, info } = await sharp(resolve(rel)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let clear = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] === 0) clear += 1;
  }
  return clear / (info.width * info.height);
}

const APP_ICON = "ios/SocraticTrade/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png";
const SOURCE = "graphics/st-mark-transparent.png";
const ANDROID = "graphics/android/ic_launcher_foreground.png";

describe("website favicon ST crop", () => {
  it("keeps a dedicated transparent ST source for web and Android", async () => {
    expect(pngHeader(read(SOURCE))).toEqual({ width: 1024, height: 1024, colorType: 6 });
    expect(pngHeader(read(ANDROID))).toEqual({ width: 1024, height: 1024, colorType: 6 });
    expect(await transparentShare(SOURCE)).toBeGreaterThan(0.5);
    expect(await transparentShare(ANDROID)).toBeGreaterThan(0.5);
  });

  it("ships transparent website PNGs and a favicon.ico", () => {
    const favicon = pngHeader(read("public/icon.png"));
    expect(favicon).toEqual({ width: 512, height: 512, colorType: 6 });
    expect(pngHeader(read("public/icons/icon-512.png"))).toEqual({ width: 512, height: 512, colorType: 6 });
    expect(pngHeader(read("public/icons/icon-192.png"))).toEqual({ width: 192, height: 192, colorType: 6 });
    expect(pngHeader(read("public/icons/apple-touch-icon-180.png"))).toEqual({
      width: 180,
      height: 180,
      colorType: 6
    });
    const ico = read("public/favicon.ico");
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(1);
  });

  it("leaves the iOS App Icon as the opaque 1024 offset ST", () => {
    const appIcon = read(APP_ICON);
    expect(pngHeader(appIcon)).toEqual({ width: 1024, height: 1024, colorType: 2 });
    expect(createHash("md5").update(appIcon).digest("hex")).toBe("46703def33604e89c127cfbaeafff1f0");
  });

  it("reads the App Icon only to rebuild the source and never writes it", () => {
    const generator = read("scripts/generate-favicon-st.mjs").toString("utf8");
    const raster = read("scripts/generate-pwa-icons.mjs").toString("utf8");
    expect(generator).toContain("never writes the App Icon file");
    expect(generator).toContain("transparency is on purpose");
    expect(generator).toContain("AppIcon-1024.png");
    expect(generator).toContain("ic_launcher_foreground.png");
    expect(raster).toMatch(/must not write the iOS App Icon/);
    expect(raster).not.toMatch(/file:\s*["']AppIcon-1024/);
    expect(raster).toContain("websitePngTargets");
  });
});
