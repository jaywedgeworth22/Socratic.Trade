#!/usr/bin/env node

/** Renders public/icon.svg (the app's icon source) to the raster PNG sizes
 *  the PWA manifest and Apple's home-screen icon need — Safari and some
 *  Android/PWA installers don't reliably rasterize the SVG themselves.
 *  Re-run whenever public/icon.svg changes:
 *
 *    node scripts/generate-pwa-icons.mjs
 */

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE_SVG = path.join(ROOT, "public", "icon.svg");
const OUT_DIR = path.join(ROOT, "public", "icons");

const TARGETS = [
  { outDir: path.join(ROOT, "public", "icons"), file: "apple-touch-icon-180.png", size: 180 },
  { outDir: path.join(ROOT, "public", "icons"), file: "icon-192.png", size: 192 },
  { outDir: path.join(ROOT, "public", "icons"), file: "icon-512.png", size: 512 },
  { outDir: path.join(ROOT, "ios", "SocraticTrade", "Assets.xcassets", "AppIcon.appiconset"), file: "AppIcon-1024.png", size: 1024 }
];

async function main() {
  for (const { outDir, file, size } of TARGETS) {
    await mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, file);
    await sharp(SOURCE_SVG, { density: 384 }).resize(size, size).png().toFile(outPath);
    console.log(`wrote ${path.relative(ROOT, outPath)} (${size}x${size})`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
