import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  S_T_SPLIT_X,
  buildFaviconSvg,
  offsetAndCrop,
  parseCandles,
  websitePngTargets
} from "../scripts/generate-favicon-st.mjs";

const source = readFileSync(resolve("graphics/favicon-st-source.svg"), "utf8");
const shipped = readFileSync(resolve("public/icon.svg"), "utf8");

describe("website favicon ST crop", () => {
  it("raises S above T and crops to a square transparent canvas", () => {
    const model = offsetAndCrop(parseCandles(source));
    expect(model.sMinY).toBeLessThan(model.tMinY);
    expect(model.viewBox.size).toBeGreaterThan(model.letterHeight);
    const svg = buildFaviconSvg(source);
    expect(svg).not.toMatch(/fill="#ffffff"/);
    expect(svg).not.toMatch(/fill="#080b12"/);
    expect(svg).not.toMatch(/<rect[^>]*width="512"[^>]*fill=/);
    expect(svg).toContain('role="img"');
  });

  it("keeps the shipped favicon on the offset transparent contract", () => {
    const model = offsetAndCrop(parseCandles(shipped));
    expect(model.sMinY).toBeLessThan(model.tMinY);
    expect(shipped).toBe(buildFaviconSvg(source));
    expect(shipped).toContain("Transparent canvas");
    const sColumns = model.lines.filter((line) => line.x1 < S_T_SPLIT_X);
    const tColumns = model.lines.filter((line) => line.x1 >= S_T_SPLIT_X);
    expect(sColumns.length).toBeGreaterThan(0);
    expect(tColumns.length).toBeGreaterThan(0);
  });

  it("rasterizes website PNGs only and never the iOS App Icon", () => {
    const targets = websitePngTargets();
    expect(targets.some((target) => target.file.endsWith("/public/icon.png"))).toBe(true);
    expect(targets.every((target) => !target.file.includes("AppIcon"))).toBe(true);
    expect(targets.every((target) => !target.file.includes("/ios/"))).toBe(true);
    const raster = readFileSync(resolve("scripts/generate-pwa-icons.mjs"), "utf8");
    expect(raster).not.toMatch(/file:\s*["']AppIcon-1024/);
    expect(raster).toMatch(/must not write the iOS App Icon/);
  });
});
