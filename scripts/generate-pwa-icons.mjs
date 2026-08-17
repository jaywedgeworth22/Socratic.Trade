#!/usr/bin/env node

/** Rasterize public/icon.svg to the website PNG sizes Safari and some
 *  Android/PWA installers need.  Re-run after the SVG changes:
 *
 *    node scripts/generate-favicon-st.mjs
 *    node scripts/generate-pwa-icons.mjs
 *
 *  Website only.  Do not write the iOS App Icon
 *  (ios/SocraticTrade/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png).
 *  That asset is the dollar-sign candlesticks and is owned by the native app.
 */

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";
import { websitePngTargets } from "./generate-favicon-st.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE_SVG = path.join(ROOT, "public", "icon.svg");

async function main() {
  for (const { file, size } of websitePngTargets()) {
    if (file.includes("AppIcon") || file.includes("ios/")) {
      throw new Error("website icon generator must not write the iOS App Icon");
    }
    await mkdir(path.dirname(file), { recursive: true });
    await sharp(SOURCE_SVG, { density: 384 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(file);
    console.log(`wrote ${path.relative(ROOT, file)} (${size}x${size})`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
