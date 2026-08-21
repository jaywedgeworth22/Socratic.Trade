#!/usr/bin/env node

/** Build the website favicon from the iOS App Icon's offset candlestick ST.
 *
 *  Source (read-only): ios/.../AppIcon-1024.png — 3D candlestick S and T,
 *  S higher than T, on a light grid.  Owner: that IS the mark; crop it so
 *  the ST barely fits and drop the background to transparent.  Website only.
 *  This script never writes the App Icon file.
 *
 *    node scripts/generate-favicon-st.mjs
 */

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const APP_ICON_SOURCE = path.join(
  ROOT,
  "ios",
  "SocraticTrade",
  "Assets.xcassets",
  "AppIcon.appiconset",
  "AppIcon-1024.png"
);

/** HSV saturation below this is treated as paper/grid (fully transparent). */
export const SAT_TRANSPARENT = 0.08;
/** HSV saturation at or above this keeps the candle fully opaque. */
export const SAT_OPAQUE = 0.26;
/** Crop to pixels at least this opaque, then pad so the ST barely fits. */
export const CROP_ALPHA = 24;
export const CROP_PAD_RATIO = 0.03;

const WEBSITE_PNGS = [
  { file: path.join(ROOT, "public", "icon.png"), size: 512 },
  { file: path.join(ROOT, "public", "icons", "icon-192.png"), size: 192 },
  { file: path.join(ROOT, "public", "icons", "icon-512.png"), size: 512 },
  { file: path.join(ROOT, "public", "icons", "apple-touch-icon-180.png"), size: 180 },
  { file: path.join(ROOT, "public", "apple-touch-icon.png"), size: 180 },
  { file: path.join(ROOT, "public", "apple-touch-icon-precomposed.png"), size: 180 }
];

export function websitePngTargets() {
  return WEBSITE_PNGS.map((target) => ({ ...target }));
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function hsvSat(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

/** Knock the light grid to alpha via a saturation ramp, then un-composite
 *  remaining fringe from white so AA edges keep candle color. */
export function knockoutGrid(rgba) {
  const out = Buffer.from(rgba);
  for (let i = 0; i < out.length; i += 4) {
    const r = out[i];
    const g = out[i + 1];
    const b = out[i + 2];
    const sat = hsvSat(r, g, b);
    const alpha = Math.round(255 * smoothstep(SAT_TRANSPARENT, SAT_OPAQUE, sat));
    if (alpha === 0) {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 0;
      continue;
    }
    if (alpha < 255) {
      const a = alpha / 255;
      out[i] = Math.min(255, Math.max(0, Math.round((r - 255 * (1 - a)) / a)));
      out[i + 1] = Math.min(255, Math.max(0, Math.round((g - 255 * (1 - a)) / a)));
      out[i + 2] = Math.min(255, Math.max(0, Math.round((b - 255 * (1 - a)) / a)));
    }
    out[i + 3] = alpha;
  }
  return out;
}

export function contentBox(rgba, width, height, minAlpha = CROP_ALPHA) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] >= minAlpha) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error("favicon knockout produced an empty image");
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function squareCrop(box, imageWidth, imageHeight, padRatio = CROP_PAD_RATIO) {
  const side = Math.ceil(Math.max(box.width, box.height) * (1 + padRatio * 2));
  const cx = (box.minX + box.maxX + 1) / 2;
  const cy = (box.minY + box.maxY + 1) / 2;
  let left = Math.round(cx - side / 2);
  let top = Math.round(cy - side / 2);
  left = Math.max(0, Math.min(left, imageWidth - side));
  top = Math.max(0, Math.min(top, imageHeight - side));
  return { left, top, width: Math.min(side, imageWidth), height: Math.min(side, imageHeight) };
}

async function readAppIconRgba() {
  const { data, info } = await sharp(APP_ICON_SOURCE).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== 1024 || info.height !== 1024) {
    throw new Error(`expected 1024x1024 App Icon, got ${info.width}x${info.height}`);
  }
  return { data, info };
}

async function writeWebsitePngs(masterPng) {
  for (const { file, size } of WEBSITE_PNGS) {
    if (file.includes("AppIcon") || file.includes(`${path.sep}ios${path.sep}`)) {
      throw new Error("website icon generator must not write the iOS App Icon");
    }
    await mkdir(path.dirname(file), { recursive: true });
    await sharp(masterPng)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(file);
    console.log(`wrote ${path.relative(ROOT, file)} (${size}x${size})`);
  }
}

export async function buildWebsiteFavicon() {
  const { data, info } = await readAppIconRgba();
  const knocked = knockoutGrid(data);
  const box = contentBox(knocked, info.width, info.height);
  const crop = squareCrop(box, info.width, info.height);
  const master = await sharp(knocked, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract(crop)
    .png()
    .toBuffer();
  return { master, box, crop };
}

async function main() {
  const { master, box, crop } = await buildWebsiteFavicon();
  console.log(
    `crop ${crop.width}x${crop.height} from content ${box.width}x${box.height} at (${box.minX},${box.minY})-(${box.maxX},${box.maxY})`
  );
  await writeWebsitePngs(master);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
