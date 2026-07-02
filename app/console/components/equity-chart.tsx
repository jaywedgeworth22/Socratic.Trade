"use client";

/** Minimal honest equity line: an SVG path over persisted snapshot points.
 *  No interpolation, no fabricated baselines — fewer than two points renders
 *  a sentence instead of a chart. Buckets are never overlaid on one axis. */

import { useMemo } from "react";
import type { EquityCurvePoint } from "@/lib/types";
import { fmtExact, fmtMoney } from "../lib/format";

const W = 640;
const H = 140;
const PAD = 6;

export function EquityChart({ points, label }: { points: EquityCurvePoint[]; label: string }) {
  const data = useMemo(
    () =>
      points
        .map((p) => ({ t: new Date(p.timestamp).getTime(), v: p.equity }))
        .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
        .sort((a, b) => a.t - b.t),
    [points]
  );

  if (data.length < 2) {
    return (
      <p className="py-4 text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">
        Not enough history to draw the {label} curve yet — it needs at least two run snapshots.
      </p>
    );
  }

  const tMin = data[0].t;
  const tMax = data[data.length - 1].t;
  const vMin = Math.min(...data.map((d) => d.v));
  const vMax = Math.max(...data.map((d) => d.v));
  const vSpan = vMax - vMin || 1;
  const tSpan = tMax - tMin || 1;

  const x = (t: number) => PAD + ((t - tMin) / tSpan) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - vMin) / vSpan) * (H - PAD * 2);
  const path = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(d.t).toFixed(1)},${y(d.v).toFixed(1)}`).join(" ");
  const rising = data[data.length - 1].v >= data[0].v;
  const stroke = rising ? "var(--con-pos)" : "var(--con-neg)";

  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${label} equity from ${fmtMoney(data[0].v)} to ${fmtMoney(data[data.length - 1].v)}`}
      >
        <path d={path} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <figcaption className="con-num mt-1 flex justify-between text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        <span title={fmtExact(points[0]?.timestamp)}>
          {new Date(tMin).toLocaleDateString()} · {fmtMoney(data[0].v)}
        </span>
        <span>
          low {fmtMoney(vMin)} · high {fmtMoney(vMax)}
        </span>
        <span title={fmtExact(points[points.length - 1]?.timestamp)}>
          {new Date(tMax).toLocaleDateString()} · {fmtMoney(data[data.length - 1].v)}
        </span>
      </figcaption>
    </figure>
  );
}
