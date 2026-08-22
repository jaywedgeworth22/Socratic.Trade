// Moveable on-box corpus root.  Writes go under CORPUS_DIR (or DATA_DIR/corpus)
// so the tree can later bind-mount to an extra virtual disk.  Reads try the new
// path first, then the legacy DATA_DIR/{sec,roic}-artifacts trees so production
// files are not stranded.

import fs from "fs";
import path from "path";

export const CORPUS_KINDS = [
  "sec",
  "roic",
  "eight-k",
  "form4",
  "thirteen-f",
  "ark",
  "transcripts",
  "experience"
] as const;

export type CorpusKind = (typeof CORPUS_KINDS)[number];

export const LEGACY_DIRNAME: Record<CorpusKind, string | null> = {
  sec: "sec-artifacts",
  roic: "roic-artifacts",
  "eight-k": "sec-artifacts",
  form4: null,
  "thirteen-f": null,
  ark: null,
  transcripts: null,
  experience: null
};

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.DATA_DIR ?? "").trim();
  return raw || "data";
}

export function corpusRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env.CORPUS_DIR ?? "").trim();
  if (override) return override;
  return path.join(dataDir(env), "corpus");
}

export function corpusKindDir(kind: CorpusKind, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(corpusRoot(env), kind);
}

export function legacyKindDir(kind: CorpusKind, env: NodeJS.ProcessEnv = process.env): string | null {
  const name = LEGACY_DIRNAME[kind];
  if (!name) return null;
  return path.join(dataDir(env), name);
}

export function padCik10(cik: string | number): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

export function sanitizeArtifactName(documentName: string): string {
  return documentName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function secArtifactRelativePath(
  cik: string,
  accession: string,
  sequence: number,
  documentName: string
): string {
  return path.join(padCik10(cik), accession, `${sequence}-${sanitizeArtifactName(documentName)}`);
}

export function secArtifactWritePath(
  cik: string,
  accession: string,
  sequence: number,
  documentName: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.join(corpusKindDir("sec", env), secArtifactRelativePath(cik, accession, sequence, documentName));
}

export function secArtifactReadPaths(
  cik: string,
  accession: string,
  sequence: number,
  documentName: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const relative = secArtifactRelativePath(cik, accession, sequence, documentName);
  const paths = [path.join(corpusKindDir("sec", env), relative)];
  const legacy = legacyKindDir("sec", env);
  if (legacy) paths.push(path.join(legacy, relative));
  return paths;
}

export function roicArtifactWriteRoot(dataRootArg?: string, env: NodeJS.ProcessEnv = process.env): string {
  return corpusKindDir("roic", envWithDataDir(dataRootArg, env));
}

export function roicArtifactLegacyRoot(dataRootArg?: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataDir(envWithDataDir(dataRootArg, env)), "roic-artifacts");
}

function envWithDataDir(dataRootArg: string | undefined, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!dataRootArg) return env;
  return { ...env, DATA_DIR: dataRootArg };
}

export function firstExistingPath(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // unreadable candidate is a miss, not a throw
    }
  }
  return null;
}

export function readFirstExistingSync(candidates: readonly string[]): string | null {
  const hit = firstExistingPath(candidates);
  if (!hit) return null;
  try {
    return fs.readFileSync(hit, "utf8");
  } catch {
    return null;
  }
}

export async function readFirstExisting(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      if (!candidate || !fs.existsSync(candidate)) continue;
      return await fs.promises.readFile(candidate, "utf8");
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export async function writeCorpusFile(filePath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, "utf8");
}

export function writeCorpusFileSync(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

export function ensureCorpusKindDir(kind: CorpusKind, env: NodeJS.ProcessEnv = process.env): string {
  const dir = corpusKindDir(kind, env);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function listSecAccessionDirs(
  accession: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const found: string[] = [];
  const roots = [corpusKindDir("sec", env), legacyKindDir("sec", env)].filter(
    (value): value is string => Boolean(value)
  );
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      for (const cikDir of fs.readdirSync(root)) {
        const accDir = path.join(root, cikDir, accession);
        try {
          if (fs.statSync(accDir).isDirectory()) found.push(accDir);
        } catch {
          // skip
        }
      }
    } catch {
      // skip unreadable root
    }
  }
  return found;
}
