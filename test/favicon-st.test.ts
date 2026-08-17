import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const S_T_SPLIT_X = 254;

function read(rel: string): string {
  return readFileSync(resolve(rel), "utf8");
}

function lineXs(svg: string): { x: number; y1: number }[] {
  return [...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)"/g)].map((match) => ({
    x: Number(match[1]),
    y1: Number(match[2])
  }));
}

describe("website favicon ST crop", () => {
  it("ships a transparent offset ST with S higher than T", () => {
    const shipped = read("public/icon.svg");
    expect(shipped).not.toMatch(/fill="#ffffff"/);
    expect(shipped).not.toMatch(/fill="#080b12"/);
    expect(shipped).not.toMatch(/<rect[^>]*width="512"[^>]*fill=/);
    expect(shipped).toContain("Transparent canvas");
    expect(shipped).toContain('role="img"');

    const lines = lineXs(shipped);
    const sYs = lines.filter((line) => line.x < S_T_SPLIT_X).map((line) => line.y1);
    const tYs = lines.filter((line) => line.x >= S_T_SPLIT_X).map((line) => line.y1);
    expect(sYs.length).toBeGreaterThan(0);
    expect(tYs.length).toBeGreaterThan(0);
    expect(Math.min(...sYs)).toBeLessThan(Math.min(...tYs));
  });

  it("keeps the pipeline source and raises S relative to that dump", () => {
    const source = read("graphics/favicon-st-source.svg");
    const shipped = read("public/icon.svg");
    const sourceS = Math.min(...lineXs(source).filter((line) => line.x < S_T_SPLIT_X).map((line) => line.y1));
    const shippedS = Math.min(...lineXs(shipped).filter((line) => line.x < S_T_SPLIT_X).map((line) => line.y1));
    expect(shippedS).toBeLessThan(sourceS);
    expect(source).toMatch(/<rect width="512" height="512" fill="#ffffff"/);
  });

  it("rasterizes website PNGs only and never the iOS App Icon", () => {
    const generator = read("scripts/generate-favicon-st.mjs");
    const raster = read("scripts/generate-pwa-icons.mjs");
    expect(generator).toContain("never writes the iOS App Icon");
    expect(raster).toMatch(/must not write the iOS App Icon/);
    expect(raster).not.toMatch(/file:\s*["']AppIcon-1024/);
    expect(raster).toContain("websitePngTargets");
  });
});
