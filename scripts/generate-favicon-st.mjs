#!/usr/bin/env node

/** Website favicon + future Android logo from the transparent ST mark.
 *
 *  Transparency is on purpose.  Do not flatten onto white or black.
 *  Source of truth: graphics/st-mark-transparent.png
 *
 *  Website and Android only.  This script never writes the App Icon file
 *  (ios/SocraticTrade/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png).
 *
 *    node scripts/generate-favicon-st.mjs
 *    node scripts/generate-favicon-st.mjs --from-app-icon
 */

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const TRANSPARENT_SOURCE = path.join(ROOT, "graphics", "st-mark-transparent.png");
export const ANDROID_FOREGROUND = path.join(ROOT, "graphics", "android", "ic_launcher_foreground.png");
export const FAVICON_ICO = path.join(ROOT, "public", "favicon.ico");

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

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const ICO_SIZES = [16, 32, 48];

export function websitePngTargets() {
  return WEBSITE_PNGS.map((target) => ({ ...target }));
}

export function androidPngTargets() {
  return [{ file: ANDROID_FOREGROUND, size: 1024 }];
}

function assertNotAppIcon(file) {
  if (file.includes("AppIcon") || file.includes(`${path.sep}ios${path.sep}`)) {
    throw new Error("website icon generator must not write the iOS App Icon");
  }
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

export function encodeIco(pngImages) {
  const count = pngImages.length;
  const header = Buffer.alloc(6 + 16 * count);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = header.length;
  const parts = [header];
  pngImages.forEach((img, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(img.size >= 256 ? 0 : img.size, entry);
    header.writeUInt8(img.size >= 256 ? 0 : img.size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(img.png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    parts.push(img.png);
    offset += img.png.length;
  });
  return Buffer.concat(parts);
}

async function resizeTransparentPng(source, size) {
  return sharp(source)
    .ensureAlpha()
    .resize(size, size, { fit: "contain", background: TRANSPARENT })
    .png()
    .toBuffer();
}

async function writePng(file, buffer) {
  assertNotAppIcon(file);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buffer);
  console.log(`wrote ${path.relative(ROOT, file)}`);
}

async function readAppIconRgba() {
  const { data, info } = await sharp(APP_ICON_SOURCE).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== 1024 || info.height !== 1024) {
    throw new Error(`expected 1024x1024 App Icon, got ${info.width}x${info.height}`);
  }
  return { data, info };
}

export async function buildTransparentMasterFromAppIcon() {
  const { data, info } = await readAppIconRgba();
  const knocked = knockoutGrid(data);
  const box = contentBox(knocked, info.width, info.height);
  const crop = squareCrop(box, info.width, info.height);
  const master = await sharp(knocked, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract(crop)
    .resize(1024, 1024, { fit: "contain", background: TRANSPARENT })
    .png()
    .toBuffer();
  return { master, box, crop };
}

export async function writeDerivedIcons(masterPng) {
  const meta = await sharp(masterPng).metadata();
  if (meta.channels !== 4 || !meta.hasAlpha) {
    throw new Error("ST mark source must stay RGBA; transparency is on purpose");
  }
  await writePng(TRANSPARENT_SOURCE, await resizeTransparentPng(masterPng, 1024));
  await writePng(ANDROID_FOREGROUND, await resizeTransparentPng(masterPng, 1024));
  for (const { file, size } of WEBSITE_PNGS) {
    await writePng(file, await resizeTransparentPng(masterPng, size));
  }
  const icoImages = [];
  for (const size of ICO_SIZES) {
    icoImages.push({ size, png: await resizeTransparentPng(masterPng, size) });
  }
  assertNotAppIcon(FAVICON_ICO);
  await mkdir(path.dirname(FAVICON_ICO), { recursive: true });
  await writeFile(FAVICON_ICO, encodeIco(icoImages));
  console.log(`wrote ${path.relative(ROOT, FAVICON_ICO)}`);
}

export async function buildWebsiteFavicon() {
  const { master, box, crop } = await buildTransparentMasterFromAppIcon();
  return { master, box, crop };
}

async function main() {
  const fromAppIcon = process.argv.includes("--from-app-icon");
  let master;
  if (fromAppIcon) {
    const built = await buildTransparentMasterFromAppIcon();
    master = built.master;
    console.log(
      `crop ${built.crop.width}x${built.crop.height} from content ${built.box.width}x${built.box.height} at (${built.box.minX},${built.box.minY})-(${built.box.maxX},${built.box.maxY})`
    );
  } else {
    const meta = await sharp(TRANSPARENT_SOURCE).metadata();
    if (meta.channels !== 4 || !meta.hasAlpha) {
      throw new Error("graphics/st-mark-transparent.png must stay RGBA; transparency is on purpose");
    }
    master = await sharp(TRANSPARENT_SOURCE).png().toBuffer();
  }
  await writeDerivedIcons(master);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
