"use client";

/** First-load splash: a candlestick chart that waves, breaks apart, reassembles
 *  into SOCRATIC / TRADE (ticking left + waving), then shrinks into the top-left
 *  logo which keeps ticking. Pure Canvas, responsive, any background. Plays once
 *  per tab session; skipped for prefers-reduced-motion. Click to dismiss. */

import { useEffect, useRef, useState } from "react";

type Cell = { nx: number; ntop: number; nh: number };
type Geo = { x: number; bt: number; bb: number; wt: number; wb: number; bw: number; col?: string; up?: boolean };
type Model = {
  M: number;
  candleAt: (j: number, t: number, L: Layout) => Geo;
  layout: (vw: number, vh: number) => Layout;
  END: number;
};
type Layout = {
  portrait: boolean; stackW: number; stackH: number; stackX: number; stackY: number;
  chart: { x0: number; x1: number; midY: number; amp: number };
  header: { x: number; y: number; w: number; h: number };
  sizeScale: number;
};

// shared across mounts so the loading->loaded transition doesn't restart it
let introStart: number | null = null;
let introDone = false;
let MODEL: Model | null = null;

function buildModel(): Model {
  const mulberry32 = (a: number) => () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const R = mulberry32(11);
  const rnd = (lo: number, hi: number) => lo + (hi - lo) * R();
  const gauss = (m: number, s: number) => {
    let u = 0, v = 0; while (!u) u = R(); while (!v) v = R();
    return m + s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const off = document.createElement("canvas");
  const octx = off.getContext("2d", { willReadFrequently: true })!;
  function sampleCells(text: string, fontPx: number, tracking: number, pitch: number) {
    const font = `700 ${fontPx}px Arial, "Helvetica Neue", sans-serif`;
    octx.font = font;
    const widths = [...text].map((ch) => (ch === " " ? fontPx * 0.45 : octx.measureText(ch).width));
    const total = widths.reduce((a, b) => a + b, 0) + tracking * (text.length - 1);
    const padX = Math.ceil(fontPx * 0.35), H = Math.ceil(fontPx * 1.5);
    off.width = Math.ceil(total) + padX * 2; off.height = H;
    octx.clearRect(0, 0, off.width, off.height);
    octx.fillStyle = "#fff"; octx.textBaseline = "alphabetic"; octx.font = font;
    let x = padX; const topY = Math.round(fontPx * 1.1);
    for (let i = 0; i < text.length; i++) { if (text[i] !== " ") octx.fillText(text[i], x, topY); x += widths[i] + tracking; }
    const img = octx.getImageData(0, 0, off.width, off.height).data, W = off.width;
    let x0 = W, x1 = 0, y0 = H, y1 = 0;
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
      if (img[(yy * W + xx) * 4 + 3] > 128) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
    }
    const cells: { cx: number; top: number; h: number }[] = [];
    const half = Math.floor((pitch - 4) / 2);
    for (let cx = x0 + 2; cx < x1; cx += pitch) {
      const colv: number[] = [];
      for (let yy = 0; yy < H; yy++) { let s = 0, n = 0; for (let xx = cx; xx < cx + pitch - 4 && xx < W; xx++) { s += img[(yy * W + xx) * 4 + 3]; n++; } colv.push(n ? s / n / 255 : 0); }
      let yy = 0;
      while (yy < H) { if (colv[yy] > 0.42) { const s = yy; while (yy < H && colv[yy] > 0.42) yy++; if (yy - s >= Math.round(fontPx * 0.03)) cells.push({ cx: cx - x0 + half, top: s - y0, h: yy - s }); } else yy++; }
    }
    return { cells, w: x1 - x0, h: y1 - y0 };
  }

  const SOC = sampleCells("SOCRATIC", 200, 10, 15), TRD = sampleCells("TRADE", 200, 10, 15);
  const gap = 200 * 0.34, blockW = Math.max(SOC.w, TRD.w), blockH = SOC.h + gap + TRD.h;
  const STACK: Cell[] = [];
  for (const c of SOC.cells) STACK.push({ nx: (c.cx + (blockW - SOC.w) / 2) / blockW, ntop: c.top / blockH, nh: c.h / blockH });
  for (const c of TRD.cells) STACK.push({ nx: (c.cx + (blockW - TRD.w) / 2) / blockW, ntop: (SOC.h + gap + c.top) / blockH, nh: c.h / blockH });
  const STACK_AR = blockW / blockH, M = STACK.length;

  function lineToM(text: string, m: number) {
    const s = sampleCells(text, 200, 10, 15), runs = s.cells, R2 = runs.length;
    const tot = runs.reduce((a, r) => a + r.h, 0);
    const raw = runs.map((r) => 1 + (m - R2) * r.h / tot), alloc = raw.map((x) => Math.floor(x));
    const rem = m - alloc.reduce((a, b) => a + b, 0);
    const ord = [...raw.keys()].sort((a, b) => raw[b] - alloc[b] - (raw[a] - alloc[a]));
    for (let i = 0; i < Math.max(0, rem); i++) alloc[ord[i]]++;
    let out: { cx: number; top: number; h: number }[] = [];
    for (let i = 0; i < runs.length; i++) { const c = Math.max(1, alloc[i]); for (let k = 0; k < c; k++) out.push({ cx: runs[i].cx, top: runs[i].top, h: runs[i].h }); } // overlap on the natural stroke (one clean candle), don't subdivide
    while (out.length < m) out.push({ ...out[out.length - 1] });
    out = out.slice(0, m);
    return { cells: out.map((c) => ({ nx: c.cx / s.w, ntop: c.top / s.h, nh: c.h / s.h })) as Cell[], ar: s.w / s.h };
  }
  const HL = lineToM("SOCRATIC TRADE", M), HEADER = HL.cells, HEADER_AR = HL.ar;

  const rw: number[] = [0];
  for (let i = 0; i < M; i++) { let st = gauss(0, 11); if (R() < 0.16) st += gauss(0, 34); rw.push(rw[rw.length - 1] + st); }
  { const n = rw.length; let sx = 0, sy = 0, sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sx += i; sy += rw[i]; sxx += i * i; sxy += i * rw[i]; } const a1 = (n * sxy - sx * sy) / (n * sxx - sx * sx), a0 = (sy - a1 * sx) / n; for (let i = 0; i < n; i++) rw[i] -= a1 * i + a0; }
  const hi: number[] = [], lo: number[] = []; for (let i = 0; i < M; i++) { hi.push(rnd(5, 30)); lo.push(rnd(5, 30)); }
  const RWs = Math.max(...rw.map(Math.abs)) || 1, WAMP = 0.08;
  const chartPrice = (i: number, t: number) => {
    const trend = 0.82 - 0.55 * (i / M), wob = 0.18 * (rw[i] / RWs), u = i / M;
    const wv = WAMP * (0.6 * Math.sin(2 * Math.PI * 1.5 * u - t * 1.6) + 0.4 * Math.sin(2 * Math.PI * 2.6 * u - t * 1.05 + 0.7));
    return Math.max(0.02, Math.min(0.98, trend + wob + wv));
  };
  const G = ["#0e9358", "#12a565", "#18b271"], RDc = ["#c22648", "#d3365a", "#dd4076"];
  const BL: number[] = [], FD: number[] = [], AR: number[] = [], WX2: number[] = [], WY2: number[] = [], P4s: number[] = [], P4e: number[] = [], WX4: number[] = [], WY4: number[] = [], INFRAC: number[] = [], INCOL: string[] = [];
  for (let j = 0; j < M; j++) {
    BL.push(rnd(1.2, 2.6)); FD.push(rnd(2.6, 3.3)); AR.push(BL[j] + FD[j]);
    const a = rnd(0, 2 * Math.PI), r = rnd(0.35, 1) * 0.11; WX2.push(Math.cos(a) * r); WY2.push(Math.sin(a) * r);
    const s = rnd(0, 0.26); let e = rnd(0.8, 1); if (e < s + 0.42) e = Math.min(1, s + 0.42); P4s.push(s); P4e.push(e);
    const a2 = rnd(0, 2 * Math.PI), r2 = rnd(0.35, 1) * 0.06; WX4.push(Math.cos(a2) * r2); WY4.push(Math.sin(a2) * r2);
    const o = chartPrice(j, BL[j]), c = chartPrice(Math.min(j + 1, M), BL[j]), mag = Math.min(1, Math.abs(c - o) / 0.12);
    INFRAC.push(0.34 + 0.6 * mag); INCOL.push((c < o ? G : RDc)[Math.min(2, Math.floor(mag * 3))]);
  }
  // END: fade begins right after the candles land on the header logo (T4) — the
  // persistent HeaderLogo owns the forever-tick, so the overlay hands off at once
  // instead of holding and double-drawing the wordmark.
  const T2B = Math.max(...AR), T3 = T2B + 0.75, T4 = T3 + 2.25, END = T4 + 0.2;

  // Header ticker: a small green-biased price walk of P candle "units" (color + body
  // fraction + vertical offset), matching the approved candle-tick reference. Each header
  // column shows one unit; the pattern marches one column left per second, so neighbouring
  // columns differ — a lively, varied red/green ticker, never one big block of each color.
  const P = 12, hr = mulberry32(9);
  const hgauss = (m: number, sd: number) => { let u = 0, v = 0; while (!u) u = hr(); while (!v) v = hr(); return m + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const hprice: number[] = [0]; for (let i = 0; i < P; i++) hprice.push(hprice[hprice.length - 1] + hgauss(0.16, 0.9));
  const hrets = hprice.slice(1).map((v, i) => v - hprice[i]), hmx = Math.max(...hrets.map(Math.abs)) || 1;
  const UNITS = hrets.map((r) => { const up = r >= 0, mag = Math.abs(r) / hmx; return { col: (up ? G : RDc)[Math.min(2, Math.floor(mag * 3))], frac: 0.4 + 0.45 * mag, off: up ? 0.3 : 0.62 }; });
  const hxKey = (nx: number) => Math.round(nx * 1000);
  const uniqHx = [...new Set(HEADER.map((c) => hxKey(c.nx)))].sort((a, b) => a - b);
  const hColMap = new Map(uniqHx.map((v, i) => [v, i]));
  const HCOL = HEADER.map((c) => hColMap.get(hxKey(c.nx))!), HSHORT = HEADER.map((c) => c.nh < 0.16), NCOL = uniqHx.length;

  const layout = (vw: number, vh: number): Layout => {
    const portrait = vh > vw;
    const stackW = Math.min(portrait ? vw * 0.9 : vw * 0.8, vh * STACK_AR * 0.62), stackH = stackW / STACK_AR;
    const cm = Math.max(18, vw * 0.03);
    // Fallback header box (used only until the real top-bar logo can be measured):
    // small, top-left, matching the persistent HeaderLogo's ~18px height.
    const pad = Math.max(14, vw * 0.014), logoH = Math.min(Math.max(vh * 0.024, 16), 22, (vw - 2 * pad) / HEADER_AR);
    return {
      portrait, stackW, stackH, stackX: (vw - stackW) / 2, stackY: (vh - stackH) * 0.46,
      chart: { x0: cm, x1: vw - cm, midY: vh * (portrait ? 0.42 : 0.5), amp: vh * (portrait ? 0.34 : 0.4) },
      header: { x: pad, y: pad, w: logoH * HEADER_AR, h: logoH }, sizeScale: stackW / blockW,
    };
  };
  const chartGeom = (j: number, t: number, L: Layout): Geo => {
    const c = L.chart, x = c.x0 + (j + 0.5) * (c.x1 - c.x0) / M;
    const o = c.midY + (chartPrice(j, t) - 0.5) * c.amp, cl = c.midY + (chartPrice(j + 1, t) - 0.5) * c.amp;
    const bt = Math.min(o, cl), bb = Math.max(o, cl), bw = (c.x1 - c.x0) / M * 0.55;
    return { x, bt, bb, wt: bt - hi[j] * 0.35 * (c.amp / 300), wb: bb + lo[j] * 0.35 * (c.amp / 300), bw, up: cl < o };
  };
  const stackGeom = (j: number, L: Layout): Geo => {
    const s = STACK[j], top = L.stackY + s.ntop * L.stackH, h = s.nh * L.stackH;
    const bh = Math.max(3, h * INFRAC[j]), bt = top + (h - bh) / 2, bw = Math.max(2.4, L.sizeScale * 15 * 0.34);
    return { x: L.stackX + s.nx * L.stackW, bt, bb: bt + bh, wt: top, wb: top + h, bw };
  };
  const headerGeom = (j: number, L: Layout): Geo => {
    const s = HEADER[j], top = L.header.y + s.ntop * L.header.h, h = s.nh * L.header.h;
    const bh = Math.max(1.6, h * INFRAC[j]), bt = top + (h - bh) / 2, bw = Math.max(1.4, L.header.w / NCOL * 0.55);
    return { x: L.header.x + s.nx * L.header.w, bt, bb: bt + bh, wt: top, wb: top + h, bw };
  };
  const smoother = (p: number) => { p = Math.max(0, Math.min(1, p)); return p * p * p * (p * (p * 6 - 15) + 10); };
  const magnetic = (p: number) => { if (p <= 0) return 0; if (p >= 1) return 1; return smoother(p) + 0.055 * Math.sin(Math.PI * Math.max(0, p - 0.5) / 0.5); };
  const fly = (p: number, s: Geo, d: Geo, wx: number, wy: number, scale: number): Geo => {
    p = Math.max(0, Math.min(1, p)); const a = magnetic(p), bump = Math.sin(Math.PI * p), dy = wy * bump * scale;
    return { x: s.x + (d.x - s.x) * a + wx * bump * scale, bt: s.bt + (d.bt - s.bt) * a + dy, bb: s.bb + (d.bb - s.bb) * a + dy, wt: s.wt + (d.wt - s.wt) * a + dy, wb: s.wb + (d.wb - s.wb) * a + dy, bw: s.bw + (d.bw - s.bw) * a };
  };
  const waveY = (col: number, t: number, amp: number) => amp * (0.6 * Math.sin(0.42 * col - t * 1.4) + 0.4 * Math.sin(0.72 * col - t * 1.02 + 0.5));
  // CENTER words + morph: gentle ripple only. Bodies/colors stay as formed (no field
  // reshape — that caused the sudden "flip"); amplitude fades to zero over the morph.
  const waveRipple = (s: Geo, t: number, L: Layout) => {
    const amp = L.stackH * 0.05 * (t < T3 ? 1 : 1 - (t - T3) / (T4 - T3));
    const wy = waveY(s.x / 24, t, amp); s.wt += wy; s.wb += wy; s.bt += wy; s.bb += wy;
  };
  // HEADER: discrete per-second candlestick ticker — each column shows its own varied unit
  // and the pattern marches one column left per second (never one big block of red/green).
  const headerTick = (s: Geo, j: number, t: number) => {
    const u = UNITS[(((HCOL[j] + Math.floor(t - T4)) % P) + P) % P];
    const wh = s.wb - s.wt, frac = HSHORT[j] ? Math.max(u.frac, 0.82) : u.frac, bh = Math.max(1.4, wh * frac);
    s.bt = s.wt + (wh - bh) * u.off; s.bb = s.bt + bh; s.col = u.col;
  };
  const candleAt = (j: number, t: number, L: Layout): Geo => {
    if (t < BL[j]) { const g = chartGeom(j, t, L); g.col = g.up ? "#18b271" : "#d3365a"; return g; }
    const stack = { ...stackGeom(j, L), col: INCOL[j] }, header = { ...headerGeom(j, L), col: INCOL[j] };
    if (t < AR[j]) { const g = chartGeom(j, BL[j], L); return { ...fly((t - BL[j]) / FD[j], g, stack, WX2[j], WY2[j], L.stackW), col: INCOL[j] }; }
    let s: Geo;
    if (t < T3) s = { ...stack };
    else if (t < T4) { const a = (t - T3) / (T4 - T3), pj = (a - P4s[j]) / (P4e[j] - P4s[j]); s = { ...fly(pj, stack, header, WX4[j], WY4[j], L.stackW), col: INCOL[j] }; }
    else s = { ...header };
    if (t < T4) waveRipple(s, t, L); else headerTick(s, j, t);
    return s;
  };
  return { M, candleAt, layout, END };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

export function ConsoleIntro() {
  const [hidden, setHidden] = useState(introDone);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (introDone) return;
    // deferred so we never call setState synchronously inside the effect body
    const hide = () => { introDone = true; queueMicrotask(() => setHidden(true)); };
    let sessionShown = false;
    try { sessionShown = sessionStorage.getItem("st.introShown") === "1"; } catch { /* ignore */ }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (sessionShown || reduce) { hide(); return; }

    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) { hide(); return; }
    if (!MODEL) { try { MODEL = buildModel(); } catch { hide(); return; } }
    const model = MODEL;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let VW = 0, VH = 0, L = model.layout(1, 1), raf = 0, fading = false, done = false, fadeTimer = 0;
    // The intro's final candles land on the REAL top-bar brand logo so the splash
    // hands off seamlessly into it. We measure [data-brand-logo] (in the DOM behind
    // this overlay) and use its viewport rect as the header box; until it exists
    // (e.g. still loading) we fall back to the small computed top-left box.
    let headerBox: { x: number; y: number; w: number; h: number } | null = null;
    const measureHeader = () => {
      const el = document.querySelector<HTMLElement>("[data-brand-logo]");
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width > 2 && r.height > 2) headerBox = { x: r.left, y: r.top, w: r.width, h: r.height };
    };
    const resize = () => { VW = window.innerWidth; VH = window.innerHeight; canvas.width = VW * dpr; canvas.height = VH * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); L = model.layout(VW, VH); measureHeader(); };
    resize();
    window.addEventListener("resize", resize);

    const finish = () => {
      if (done) return; done = true;
      try { sessionStorage.setItem("st.introShown", "1"); } catch { /* ignore */ }
      hide();
    };
    const skip = () => { if (!fading) startFade(); };
    const startFade = () => { fading = true; if (wrap) { wrap.style.opacity = "0"; } fadeTimer = window.setTimeout(finish, 720); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" || e.key === "Enter" || e.key === " ") skip(); };
    wrap.addEventListener("click", skip);
    window.addEventListener("keydown", onKey);

    const loop = (now: number) => {
      if (introStart == null) introStart = now;
      const t = (now - introStart) / 1000;
      if (!headerBox) measureHeader();      // the top bar may mount after the intro starts
      if (headerBox) L.header = headerBox;  // land the shrinking candles on the real logo box
      ctx.clearRect(0, 0, VW, VH);
      for (let j = 0; j < model.M; j++) {
        const c = model.candleAt(j, t, L); const col = c.col || "#18b271";
        ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, c.bw * 0.26); ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(c.x, c.wt); ctx.lineTo(c.x, c.wb); ctx.stroke();
        ctx.fillStyle = col; const bh = Math.max(1.4, c.bb - c.bt); roundRect(ctx, c.x - c.bw / 2, c.bt, c.bw, bh, Math.min(2, c.bw * 0.25)); ctx.fill();
      }
      if (!fading && t > model.END) startFade();
      if (!done) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => { cancelAnimationFrame(raf); if (fadeTimer) window.clearTimeout(fadeTimer); window.removeEventListener("resize", resize); window.removeEventListener("keydown", onKey); wrap.removeEventListener("click", skip); };
  }, []);

  if (hidden) return null;
  return (
    <div
      ref={wrapRef}
      aria-hidden
      style={{ position: "fixed", inset: 0, zIndex: 200, background: "transparent", transition: "opacity .7s ease", cursor: "pointer" }}
    >
      <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
    </div>
  );
}
