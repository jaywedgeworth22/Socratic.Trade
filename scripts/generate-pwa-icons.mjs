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
  { file: "apple-touch-icon-180.png", size: 180 },
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 }
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const { file, size } of TARGETS) {
    const outPath = path.join(OUT_DIR, file);
    await sharp(SOURCE_SVG, { density: 384 }).resize(size, size).png().toFile(outPath);
    console.log(`wrote ${path.relative(ROOT, outPath)} (${size}x${size})`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
