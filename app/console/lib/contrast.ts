/** WCAG 2.x relative-luminance / contrast helpers for console token checks.
 *
 *  Chip text is 11px/600 on a tone-soft fill, so the ratio that matters is
 *  text-on-soft-fill (not text-on-plain-surface). AA for that size is 4.5:1. */

export function srgbChannelToLinear(channel: number): number {
  const x = channel / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) {
    throw new Error(`expected #rrggbb, got ${hex}`);
  }
  const r = srgbChannelToLinear(parseInt(normalized.slice(0, 2), 16));
  const g = srgbChannelToLinear(parseInt(normalized.slice(2, 4), 16));
  const b = srgbChannelToLinear(parseInt(normalized.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const left = relativeLuminance(a);
  const right = relativeLuminance(b);
  const lighter = Math.max(left, right);
  const darker = Math.min(left, right);
  return (lighter + 0.05) / (darker + 0.05);
}

/** sRGB alpha-composite of `hex` at `alpha` over an opaque background. */
export function compositeOver(hex: string, alpha: number, background: string): string {
  const src = hex.replace("#", "");
  const dst = background.replace("#", "");
  const mix = (from: number, to: number) => Math.round(from * alpha + to * (1 - alpha));
  const channels = [0, 2, 4].map((offset) => {
    const from = parseInt(src.slice(offset, offset + 2), 16);
    const to = parseInt(dst.slice(offset, offset + 2), 16);
    return mix(from, to).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

export const WCAG_AA_SMALL_TEXT = 4.5;
