#!/usr/bin/env node

/** Build the website favicon from the candlestick-ST pipeline dump.
 *
 *  Source: graphics/favicon-st-source.svg — the last committed
 *  sampleWordmark("ST") -> buildTickerUnits() -> drawTicker geometry
 *  from PR #1626 (high-contrast greens/reds from the 2026-08-01 pass).
 *
 *  Owner ask (#2731): crop so the ST barely fits, transparent background,
 *  offset S higher than T.  Website only — never writes the iOS App Icon
 *  (dollar-sign candlesticks).
 *
 *    node scripts/generate-favicon-st.mjs
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE_SVG = path.join(ROOT, "graphics", "favicon-st-source.svg");
const OUT_SVG = path.join(ROOT, "public", "icon.svg");

/** Midpoint of the 21.48-pitch column gap between S (x=232.37) and T (x=275.33). */
export const S_T_SPLIT_X = 254;

/** Raise S by this fraction of the shared letter height so the combined
 *  mark is nearly square and the tight crop barely contains both letters. */
export const S_RAISE_OF_LETTER_HEIGHT = 0.6;

/** Inset around the offset mark, as a fraction of the square side.
 *  Small on purpose: the owner asked for the ST to barely fit. */
export const CROP_PAD_RATIO = 0.02;

const ATTR_RE = /([a-zA-Z0-9:-]+)="([^"]*)"/g;
const LINE_RE = /<line\s+([^>]+?)\s*\/>/g;
const RECT_RE = /<rect\s+([^>]+?)\s*\/>/g;

function attrs(raw) {
  const out = {};
  for (const match of raw.matchAll(ATTR_RE)) out[match[1]] = match[2];
  return out;
}

function num(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`expected number, got ${value}`);
  return n;
}

/** Parse pipeline candles.  Drops the full-bleed background rect. */
export function parseCandles(svg) {
  const lines = [];
  for (const match of svg.matchAll(LINE_RE)) {
    const a = attrs(match[1]);
    lines.push({
      kind: "line",
      x1: num(a.x1),
      y1: num(a.y1),
      x2: num(a.x2),
      y2: num(a.y2),
      stroke: a.stroke,
      strokeWidth: num(a["stroke-width"]),
      strokeLinecap: a["stroke-linecap"] ?? "round"
    });
  }
  const rects = [];
  for (const match of svg.matchAll(RECT_RE)) {
    const a = attrs(match[1]);
    if (a.x === undefined || a.y === undefined) continue;
    const width = num(a.width);
    const height = num(a.height);
    if (width >= 500 && height >= 500) continue;
    rects.push({
      kind: "rect",
      x: num(a.x),
      y: num(a.y),
      width,
      height,
      rx: a.rx ?? "1.50",
      fill: a.fill
    });
  }
  if (lines.length === 0 || rects.length === 0) {
    throw new Error("favicon source has no candlestick geometry");
  }
  return { lines, rects };
}

function letterOf(x) {
  return x < S_T_SPLIT_X ? "S" : "T";
}

export function offsetAndCrop(candles) {
  const ys = candles.lines.flatMap((line) => [line.y1, line.y2]);
  const letterHeight = Math.max(...ys) - Math.min(...ys);
  const raise = letterHeight * S_RAISE_OF_LETTER_HEIGHT;

  const lines = candles.lines.map((line) => {
    const dy = letterOf(line.x1) === "S" ? raise : 0;
    return { ...line, y1: line.y1 - dy, y2: line.y2 - dy, letter: letterOf(line.x1) };
  });
  const rects = candles.rects.map((rect) => {
    const cx = rect.x + rect.width / 2;
    const dy = letterOf(cx) === "S" ? raise : 0;
    return { ...rect, y: rect.y - dy, letter: letterOf(cx) };
  });

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const line of lines) {
    const pad = line.strokeWidth;
    minX = Math.min(minX, line.x1 - pad, line.x2 - pad);
    maxX = Math.max(maxX, line.x1 + pad, line.x2 + pad);
    minY = Math.min(minY, line.y1 - pad, line.y2 - pad);
    maxY = Math.max(maxY, line.y1 + pad, line.y2 + pad);
  }
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    maxX = Math.max(maxX, rect.x + rect.width);
    minY = Math.min(minY, rect.y);
    maxY = Math.max(maxY, rect.y + rect.height);
  }

  const width = maxX - minX;
  const height = maxY - minY;
  const side = Math.max(width, height);
  const pad = side * CROP_PAD_RATIO;
  const square = side + pad * 2;
  const viewMinX = minX - (square - width) / 2;
  const viewMinY = minY - (square - height) / 2;

  return {
    lines,
    rects,
    raise,
    letterHeight,
    viewBox: { x: viewMinX, y: viewMinY, size: square },
    sMinY: Math.min(...lines.filter((line) => line.letter === "S").map((line) => line.y1)),
    tMinY: Math.min(...lines.filter((line) => line.letter === "T").map((line) => line.y1))
  };
}

function fmt(value) {
  return Number(value).toFixed(2);
}

export function renderFaviconSvg(model) {
  const { x, y, size } = model.viewBox;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(x)} ${fmt(y)} ${fmt(size)} ${fmt(size)}" role="img" aria-label="Socratic Trade">`,
    `  <!-- Cropped offset candlestick ST (S higher than T). Transparent canvas. Website favicon only. -->`
  ];
  for (const line of model.lines) {
    parts.push(
      `  <line x1="${fmt(line.x1)}" y1="${fmt(line.y1)}" x2="${fmt(line.x2)}" y2="${fmt(line.y2)}" stroke="${line.stroke}" stroke-width="${fmt(line.strokeWidth)}" stroke-linecap="${line.strokeLinecap}"/>`
    );
  }
  for (const rect of model.rects) {
    parts.push(
      `  <rect x="${fmt(rect.x)}" y="${fmt(rect.y)}" width="${fmt(rect.width)}" height="${fmt(rect.height)}" rx="${rect.rx}" fill="${rect.fill}"/>`
    );
  }
  parts.push("</svg>", "");
  return parts.join("\n");
}

export function buildFaviconSvg(sourceSvg) {
  return renderFaviconSvg(offsetAndCrop(parseCandles(sourceSvg)));
}

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

async function rasterizeWebsitePngs(svg) {
  const sharp = (await import("sharp")).default;
  for (const { file, size } of WEBSITE_PNGS) {
    await mkdir(path.dirname(file), { recursive: true });
    await sharp(Buffer.from(svg), { density: 384 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(file);
    console.log(`wrote ${path.relative(ROOT, file)} (${size}x${size})`);
  }
}

async function main() {
  const source = await readFile(SOURCE_SVG, "utf8");
  const model = offsetAndCrop(parseCandles(source));
  if (!(model.sMinY < model.tMinY)) {
    throw new Error(`S must sit higher than T (sMinY=${model.sMinY}, tMinY=${model.tMinY})`);
  }
  const svg = renderFaviconSvg(model);
  if (/<rect[^>]*width="512"[^>]*fill=/.test(svg) || /fill="#ffffff"/.test(svg) || /fill="#080b12"/.test(svg)) {
    throw new Error("generated favicon must stay transparent (no full-bleed fill)");
  }
  await mkdir(path.dirname(OUT_SVG), { recursive: true });
  await writeFile(OUT_SVG, svg);
  console.log(`wrote ${path.relative(ROOT, OUT_SVG)} (S raised ${model.raise.toFixed(1)}px, viewBox ${model.viewBox.size.toFixed(1)})`);
  await rasterizeWebsitePngs(svg);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
