"use client";

/** Policy editing toolkit: sparse-draft editing over the live policy, a diff
 *  review sheet, and asymmetric friction — tightening saves with one click,
 *  loosening on LIVE money requires typing CONFIRM. The commit model comes
 *  from the explainability design: you never "save settings", you review and
 *  commit a change. */

import { useMemo, useState, type ReactNode } from "react";
import type { TradingPolicy } from "@/lib/types";
import { savePolicy, ConsoleApiError, type PolicyPatchBody } from "../lib/api";
import type { RealityInfo } from "../lib/derive";
import { cx, fmtNum, EM_DASH } from "../lib/format";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { Btn, Chip, Field, NumInput, TextInput, Toggle } from "../ui/primitives";
import { Sheet } from "../ui/sheet";
import { TypedConfirm } from "./chrome";

// ── Field metadata ───────────────────────────────────────────────────────────

export type FieldKind = "money" | "pct" | "int" | "minutes" | "seconds" | "bool" | "text";

export interface FieldDef {
  /** Dot path into TradingPolicy, e.g. "maxOrderNotional" or "riskRules.stopLossPct". */
  path: string;
  label: string;
  kind: FieldKind;
  hint?: string;
  /** Direction that LOOSENS the cage (drives the typed-confirm friction on live). */
  looserWhen?: "up" | "down" | "on";
  /** Optional numeric: blank clears the field (server strips nulls → guard off/default). */
  optional?: boolean;
}

export function getAtPath(policy: TradingPolicy, path: string): unknown {
  let value: unknown = policy;
  for (const key of path.split(".")) {
    if (value == null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

// ── Draft state (sparse: only touched fields) ────────────────────────────────

export interface PolicyDraft {
  values: Record<string, unknown>;
  set: (path: string, value: unknown) => void;
  clear: () => void;
}

export function usePolicyDraft(): PolicyDraft {
  const [values, setValues] = useState<Record<string, unknown>>({});
  return {
    values,
    set: (path, value) => setValues((prev) => ({ ...prev, [path]: value })),
    clear: () => setValues({})
  };
}

export interface DiffEntry {
  def: FieldDef;
  from: unknown;
  to: unknown;
  direction: "looser" | "tighter" | "changed";
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

function classify(def: FieldDef, from: unknown, to: unknown): DiffEntry["direction"] {
  if (!def.looserWhen) return "changed";
  if (def.kind === "bool") {
    const on = to === true;
    return def.looserWhen === "on" ? (on ? "looser" : "tighter") : on ? "tighter" : "looser";
  }
  const fromNum = typeof from === "number" && Number.isFinite(from) ? from : null;
  const toNum = typeof to === "number" && Number.isFinite(to) ? to : null;
  // Clearing a cap removes it entirely — the loosest possible move for "up" caps.
  if (toNum === null && fromNum !== null) return def.looserWhen === "up" ? "looser" : "tighter";
  if (fromNum === null && toNum !== null) return def.looserWhen === "up" ? "tighter" : "looser";
  if (fromNum === null || toNum === null || fromNum === toNum) return "changed";
  const up = toNum > fromNum;
  return def.looserWhen === "up" ? (up ? "looser" : "tighter") : up ? "looser" : "tighter";
}

export function computeDiff(policy: TradingPolicy, draft: PolicyDraft, defs: FieldDef[]): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (const def of defs) {
    if (!(def.path in draft.values)) continue;
    const from = getAtPath(policy, def.path);
    const to = draft.values[def.path];
    const same = (isBlank(from) && isBlank(to)) || from === to;
    if (same) continue;
    entries.push({ def, from, to, direction: classify(def, from, to) });
  }
  return entries;
}

/** Nest sparse dot-path values into the PUT body shape. Sends null for cleared
 *  optional fields — the server's stripNullsDeep turns that into "absent". */
export function buildPatch(diff: DiffEntry[]): PolicyPatchBody {
  const patch: Record<string, unknown> = {};
  for (const entry of diff) {
    const parts = entry.def.path.split(".");
    let target = patch;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (typeof target[key] !== "object" || target[key] === null) target[key] = {};
      target = target[key] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = entry.to === undefined || entry.to === "" ? null : entry.to;
  }
  return patch;
}

// ── Field renderer ───────────────────────────────────────────────────────────

function fmtValue(def: FieldDef, v: unknown): string {
  if (isBlank(v)) return def.optional ? "off" : EM_DASH;
  if (def.kind === "bool") return v === true ? "on" : "off";
  if (def.kind === "money") return `$${fmtNum(v as number)}`;
  if (def.kind === "pct") return `${fmtNum(v as number)}%`;
  if (def.kind === "minutes") return `${fmtNum(v as number)} min`;
  if (def.kind === "seconds") return `${fmtNum(v as number)} s`;
  return String(v);
}

export function PolicyFieldRow({ def, policy, draft }: { def: FieldDef; policy: TradingPolicy; draft: PolicyDraft }) {
  const current = getAtPath(policy, def.path);
  const touched = def.path in draft.values;
  const value = touched ? draft.values[def.path] : current;

  if (def.kind === "bool") {
    return (
      <div className="flex items-start justify-between gap-4 py-2">
        <div>
          <div className="text-[length:var(--con-fs-sm)] font-semibold">
            {def.label}
            {touched && <span className="ml-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">edited</span>}
          </div>
          {def.hint && <p className="mt-0.5 max-w-xl text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">{def.hint}</p>}
        </div>
        <Toggle checked={value === true} onChange={(next) => draft.set(def.path, next)} label={def.label} />
      </div>
    );
  }

  const unit = def.kind === "money" ? "$" : def.kind === "pct" ? "%" : def.kind === "minutes" ? "min" : def.kind === "seconds" ? "sec" : undefined;
  const numeric = def.kind !== "text";
  const display = isBlank(value) ? "" : String(value);

  return (
    <div className="py-2">
      <div className="flex items-end justify-between gap-4">
        <label className="text-[length:var(--con-fs-sm)] font-semibold" htmlFor={`pf-${def.path}`}>
          {def.label}
          {touched && <span className="ml-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">edited</span>}
        </label>
        <div className="flex w-36 items-center gap-1.5">
          {unit === "$" && <span className="text-[color:var(--con-faint)]">$</span>}
          {numeric ? (
            <NumInput
              id={`pf-${def.path}`}
              value={display}
              placeholder={def.optional ? "off" : undefined}
              onChange={(e) => {
                const raw = e.target.value;
                draft.set(def.path, raw === "" ? null : Number(raw));
              }}
            />
          ) : (
            <TextInput id={`pf-${def.path}`} value={display} onChange={(e) => draft.set(def.path, e.target.value)} />
          )}
          {unit && unit !== "$" && <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{unit}</span>}
        </div>
      </div>
      {def.hint && <p className="mt-0.5 max-w-xl text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">{def.hint}</p>}
    </div>
  );
}

// ── Save bar + review sheet ──────────────────────────────────────────────────

export function PolicySaveBar({
  policy,
  draft,
  defs,
  reality,
  extraPatch
}: {
  policy: TradingPolicy;
  draft: PolicyDraft;
  defs: FieldDef[];
  reality: RealityInfo;
  /** Extra body merged into the PUT (e.g. full arrays that aren't diffable). */
  extraPatch?: PolicyPatchBody;
}) {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const diff = useMemo(() => computeDiff(policy, draft, defs), [policy, draft, defs]);
  const extraCount = extraPatch ? Object.keys(extraPatch).length : 0;
  const changeCount = diff.length + extraCount;
  if (changeCount === 0) return null;

  const hasLooser = diff.some((d) => d.direction === "looser");
  const needsTyped = reality.tone === "live" && hasLooser;

  const commit = async () => {
    setBusy(true);
    try {
      await savePolicy({ ...buildPatch(diff), ...(extraPatch ?? {}) });
      await refresh();
      draft.clear();
      setReviewOpen(false);
      setTyped("");
      toast.push("pos", "Guardrails updated", "Takes effect from the next policy-gate evaluation.");
    } catch (error) {
      toast.push("neg", "Save refused", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="sticky bottom-16 z-40 lg:bottom-4">
        <div className="con-card flex items-center justify-between gap-3 border-[color:var(--con-warn)] px-4 py-2.5">
          <span className="text-[length:var(--con-fs-sm)] font-semibold">
            {changeCount} uncommitted {changeCount === 1 ? "change" : "changes"}
          </span>
          <div className="flex gap-2">
            <Btn variant="ghost" size="sm" onClick={() => draft.clear()}>
              Discard
            </Btn>
            <Btn variant="primary" size="sm" onClick={() => setReviewOpen(true)}>
              Review &amp; save
            </Btn>
          </div>
        </div>
      </div>

      <Sheet open={reviewOpen} onClose={() => setReviewOpen(false)} title="Review changes" tone={needsTyped ? "live" : undefined}>
        <div className="mb-3 flex items-center gap-2 text-[length:var(--con-fs-sm)]">
          <Chip tone={reality.tone}>
            {reality.word} · {reality.phrase}
          </Chip>
          <span className="text-[color:var(--con-muted)]">Changes apply to this account only.</span>
        </div>
        <div className="flex flex-col divide-y divide-[color:var(--con-line)]">
          {diff.map((d) => (
            <div key={d.def.path} className="flex items-center justify-between gap-3 py-2 text-[length:var(--con-fs-sm)]">
              <span className="font-semibold">{d.def.label}</span>
              <span className="con-num flex items-center gap-2">
                <span className="text-[color:var(--con-faint)]">{fmtValue(d.def, d.from)}</span>
                <span className="text-[color:var(--con-faint)]">→</span>
                <span>{fmtValue(d.def, d.to)}</span>
                {d.direction !== "changed" && (
                  <span
                    className={cx("text-[length:var(--con-fs-xs)] font-bold uppercase")}
                    style={{ color: d.direction === "looser" ? "var(--con-warn)" : "var(--con-pos)" }}
                  >
                    {d.direction}
                  </span>
                )}
              </span>
            </div>
          ))}
          {extraPatch &&
            Object.keys(extraPatch).map((key) => (
              <div key={key} className="py-2 text-[length:var(--con-fs-sm)]">
                <span className="font-semibold">{key}</span>{" "}
                <span className="text-[color:var(--con-faint)]">updated</span>
              </div>
            ))}
        </div>

        {needsTyped ? (
          <TypedConfirm
            phrase="CONFIRM"
            value={typed}
            onChange={setTyped}
            busy={busy}
            confirmLabel="Commit changes"
            note="At least one change LOOSENS a limit on a LIVE (real money) account. Loosening costs a typed word; tightening never does."
            onConfirm={() => void commit()}
          />
        ) : (
          <div className="mt-4 flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setReviewOpen(false)} disabled={busy}>
              Cancel
            </Btn>
            <Btn variant="primary" onClick={() => void commit()} disabled={busy}>
              {busy ? "Saving…" : "Commit changes"}
            </Btn>
          </div>
        )}
      </Sheet>
    </>
  );
}

// ── Section wrapper ──────────────────────────────────────────────────────────

export function AdvancedGroup({ title, children, defaultOpen }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="con-disclosure border-t border-[color:var(--con-line)]" open={defaultOpen}>
      <summary>{title}</summary>
      <div className="pb-3">{children}</div>
    </details>
  );
}
