"use client";

/** Positions table with a per-position protection column derived honestly
 *  from the snapshot (resting broker stop order, app-managed stop rule, or
 *  "—" when nothing protects). Money in tabular numerals; missing = "—". */

import type { DashboardSnapshot } from "../../dashboard-types";
import { deriveProtection } from "../lib/derive";
import { fmtMoney, fmtPct, fmtQty, EM_DASH } from "../lib/format";
import { Card, Dash, Empty, SignedText } from "../ui/primitives";
import { SymbolButton } from "../ui/symbol-drilldown";

/** Concentration cue for a position's weight vs. policy.maxSymbolExposurePct.
 *  Text-first (the label always names "over cap"), color only reinforces —
 *  a colorblind or screen-reader user still gets the same information. */
interface ExposureCue {
  tone?: "warn" | "neg";
  label?: string;
  title?: string;
}

function exposureCue(weightPct: number | undefined, capPct: number | undefined): ExposureCue {
  if (weightPct === undefined || !capPct || capPct <= 0 || weightPct <= capPct) return {};
  const ratio = weightPct / capPct;
  const grossly = ratio >= 1.5;
  return {
    tone: grossly ? "neg" : "warn",
    label: grossly ? "well over cap" : "over cap",
    title: `${fmtPct(weightPct, 1)} of account value exceeds the ${capPct}% max-single-symbol exposure cap (${ratio.toFixed(1)}x).`
  };
}

export function PositionsCard({ snapshot }: { snapshot: DashboardSnapshot }) {
  const positions = snapshot.positions ?? [];
  const equity = snapshot.portfolio?.totalMarketValue;
  const exposureCap = snapshot.policy.maxSymbolExposurePct;

  // Computed once per position and shared by both the ≥lg table and the
  // <lg card list below, so the two layouts can never drift out of sync.
  const rows = positions.map((p) => {
    const short = p.quantity < 0;
    const costBasis = p.averageCost * p.quantity;
    const unrealized =
      Number.isFinite(p.marketValue) && Number.isFinite(costBasis) ? p.marketValue - costBasis : undefined;
    const unrealizedPct =
      unrealized !== undefined && costBasis !== 0 ? (unrealized / Math.abs(costBasis)) * 100 : undefined;
    const weightPct = equity && equity !== 0 ? (p.marketValue / equity) * 100 : undefined;
    const protection = deriveProtection(p, snapshot.orders ?? [], snapshot.policy);
    const meta = snapshot.symbolMetaBySymbol?.[p.symbol];
    const exposure = exposureCue(weightPct, exposureCap);
    return { p, short, unrealized, unrealizedPct, weightPct, protection, meta, exposure };
  });

  return (
    <Card title={`Positions (${positions.length})`} padded={false}>
      {positions.length === 0 ? (
        <Empty>No open positions in this account.</Empty>
      ) : (
        <>
          <div className="hidden overflow-x-auto lg:block">
            <table className="con-table">
              <thead>
                <tr>
                  <th title="Ticker — click a symbol to open its price history and details.">Symbol</th>
                  <th className="num" title="Shares held; negative means a short position.">Qty</th>
                  <th className="num" title="Average price paid per share.">Avg cost</th>
                  <th className="num" title="Current market value of the position.">Value</th>
                  <th className="num" title="Share of the account's total market value currently tied to this position.">Weight</th>
                  <th className="num" title="Market value minus cost basis — the gain or loss if you closed now.">Unrealized</th>
                  <th title="What protects this position: a resting broker stop order, an app-managed stop rule, or nothing (—).">Protection</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ p, short, unrealized, unrealizedPct, weightPct, protection, meta, exposure }) => (
                  <tr key={p.symbol}>
                    <td>
                      <SymbolButton symbol={p.symbol} />
                      {short && (
                        <span className="ml-1.5 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-warn)]">SHORT</span>
                      )}
                      {meta?.companyName && (
                        <span className="block max-w-44 truncate pl-[26px] text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                          {meta.companyName}
                        </span>
                      )}
                    </td>
                    <td className="num con-num">{fmtQty(p.quantity)}</td>
                    <td className="num con-num">{fmtMoney(p.averageCost)}</td>
                    <td className="num con-num">{fmtMoney(p.marketValue)}</td>
                    <td className="num con-num" title={exposure.title}>
                      {weightPct === undefined ? (
                        <Dash />
                      ) : (
                        <span style={exposure.tone ? { color: exposure.tone === "neg" ? "var(--con-neg)" : "var(--con-warn)" } : undefined}>
                          {fmtPct(weightPct, 1, true)}
                          {exposure.label && (
                            <span className="ml-1 text-[length:var(--con-fs-xs)] font-semibold">({exposure.label})</span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="num">
                      {unrealized === undefined ? (
                        <Dash />
                      ) : (
                        <SignedText value={unrealized}>
                          {`${unrealized > 0 ? "+" : ""}${fmtMoney(unrealized)}`}
                          {unrealizedPct !== undefined ? ` (${fmtPct(unrealizedPct, 1, true)})` : ""}
                        </SignedText>
                      )}
                    </td>
                    <td title={protection.detail}>
                      {protection.label === null ? (
                        <span className="text-[color:var(--con-faint)]">{EM_DASH}</span>
                      ) : (
                        <span
                          className="text-[length:var(--con-fs-xs)] font-semibold"
                          style={{ color: protection.tone === "warn" ? "var(--con-warn)" : protection.tone === "pos" ? "var(--con-pos)" : "var(--con-muted)" }}
                        >
                          {protection.label}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* <lg: the table's horizontal scroll isn't a good hand-held experience —
              one card per position instead, same fields plus the same honest
              protection/exposure cues. */}
          <div className="flex flex-col divide-y divide-[color:var(--con-line)] lg:hidden">
            {rows.map(({ p, short, unrealized, unrealizedPct, weightPct, protection, meta, exposure }) => (
              <div key={p.symbol} className="flex flex-col gap-2 px-4 py-3 text-[length:var(--con-fs-sm)]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <SymbolButton symbol={p.symbol} />
                      {short && <span className="text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-warn)]">SHORT</span>}
                    </div>
                    {meta?.companyName && (
                      <div className="mt-0.5 max-w-48 truncate text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                        {meta.companyName}
                      </div>
                    )}
                  </div>
                  {weightPct !== undefined && (
                    <span
                      className="con-num shrink-0 text-right font-semibold"
                      style={exposure.tone ? { color: exposure.tone === "neg" ? "var(--con-neg)" : "var(--con-warn)" } : undefined}
                      title={exposure.title}
                    >
                      {fmtPct(weightPct, 1, true)}
                      {exposure.label && <span className="block text-[length:var(--con-fs-xs)]">{exposure.label}</span>}
                    </span>
                  )}
                </div>
                <div className="con-num grid grid-cols-2 gap-x-3 gap-y-1.5">
                  <div>
                    <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">Qty</div>
                    <div>{fmtQty(p.quantity)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">Value</div>
                    <div>{fmtMoney(p.marketValue)}</div>
                  </div>
                  <div>
                    <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">P&amp;L</div>
                    <div>
                      {unrealized === undefined ? (
                        <Dash />
                      ) : (
                        <SignedText value={unrealized}>
                          {`${unrealized > 0 ? "+" : ""}${fmtMoney(unrealized)}`}
                          {unrealizedPct !== undefined ? ` (${fmtPct(unrealizedPct, 1, true)})` : ""}
                        </SignedText>
                      )}
                    </div>
                  </div>
                  <div className="text-right" title={protection.detail}>
                    <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">Protection</div>
                    <div>
                      {protection.label === null ? (
                        <span className="text-[color:var(--con-faint)]">{EM_DASH}</span>
                      ) : (
                        <span
                          className="text-[length:var(--con-fs-xs)] font-semibold"
                          style={{ color: protection.tone === "warn" ? "var(--con-warn)" : protection.tone === "pos" ? "var(--con-pos)" : "var(--con-muted)" }}
                        >
                          {protection.label}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
