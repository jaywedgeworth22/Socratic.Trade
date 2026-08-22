// Thin Red filings pack: only proposed-symbol dossier slices, already budgeted.
// Does not re-send the 24k Green hose per opening.

import { normalizeSymbol } from "../money";

export const REVIEWER_FILINGS_PACK_CHARS = 8_000;
export const REVIEWER_PER_SYMBOL_CHARS = 4_000;

const DOSSIER_HEAD = /^### RAG Dossier for ([A-Za-z0-9.-]+)/i;

export function sliceRagDossierForSymbols(
  ragContext: string,
  symbols: readonly string[],
  opts?: { totalMax?: number; perSymbolMax?: number }
): string {
  const text = String(ragContext ?? "").trim();
  if (!text) return "";
  const wanted = new Set(
    symbols.map((symbol) => normalizeSymbol(symbol)).filter((symbol) => symbol.length > 0)
  );
  if (wanted.size === 0) return "";

  const totalMax = opts?.totalMax ?? REVIEWER_FILINGS_PACK_CHARS;
  const perSymbolMax = opts?.perSymbolMax ?? REVIEWER_PER_SYMBOL_CHARS;
  const sections = text.split(/\n\n---\n\n/);
  const picked: string[] = [];
  let used = 0;

  for (const section of sections) {
    const trimmed = section.trim();
    const match = DOSSIER_HEAD.exec(trimmed);
    if (!match) continue;
    const symbol = normalizeSymbol(match[1] ?? "");
    if (!wanted.has(symbol)) continue;
    let body = trimmed;
    if (body.length > perSymbolMax) body = body.slice(0, perSymbolMax);
    const remaining = totalMax - used;
    if (remaining < 80) break;
    if (body.length > remaining) body = body.slice(0, remaining);
    picked.push(body);
    used += body.length + 8;
    if (used >= totalMax) break;
  }
  return picked.join("\n\n---\n\n");
}
