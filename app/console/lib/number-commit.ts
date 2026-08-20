/**
 * Pure commit decisions for console numeric fields.
 *
 * These live here rather than beside their inputs because Next.js App Router restricts what a
 * `page.tsx` may export -- only `default`, `metadata`, `dynamic`, `revalidate` and friends are
 * allowed, and any other named export fails the generated `.next/types` check with
 * "Property '<name>' is incompatible with index signature ... not assignable to type 'never'".
 * Exporting the helper from `app/console/settings/page.tsx` so a test could import it broke the
 * build for exactly that reason.  Put shared pure helpers in this module instead.
 *
 * The rule these encode: a blank or unparseable field commits NOTHING.  It must never fall through
 * to a fallback value, because these fields are risk and strategy knobs -- clearing one to retype
 * it used to write the fallback to the server as a real setting.
 */

/**
 * Decide what a data-source feature number field should commit on blur.
 *
 * Returns the parsed number to PATCH, or `null` to commit nothing.  `null` covers three distinct
 * cases that all mean "do not write": blank/whitespace, unparseable text, and a value identical to
 * what is already saved (no redundant PATCH).
 */
export function resolveSourceFeatureNumberCommit(raw: string, committed: number): number | null {
  const parsed = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(parsed)) return null;
  if (parsed === committed) return null;
  return parsed;
}
