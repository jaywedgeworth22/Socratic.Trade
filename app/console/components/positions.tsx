"use client";

/** Positions table with a per-position protection column derived honestly
 *  from the snapshot (resting broker stop order, app-managed stop rule, or
 *  "—" when nothing protects). Money in tabular numerals; missing = "—". */

import type { DashboardSnapshot } from "../../dashboard-types";
import { deriveProtection } from "../lib/derive";
import { fmtMoney, fmtPct, fmtQty, EM_DASH } from "../lib/format";
import { Card, Dash, Empty, SignedText } from "../ui/primitives";

export function PositionsCard({ snapshot }: { snapshot: DashboardSnapshot }) {
  const positions = snapshot.positions ?? [];
  return (
    <Card title={`Positions (${positions.length})`} padded={false}>
      {positions.length === 0 ? (
        <Empty>No open positions in this account.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="con-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th className="num">Qty</th>
                <th className="num">Avg cost</th>
                <th className="num">Value</th>
                <th className="num">Unrealized</th>
                <th>Protection</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const short = p.quantity < 0;
                const costBasis = p.averageCost * p.quantity;
                const unrealized =
                  Number.isFinite(p.marketValue) && Number.isFinite(costBasis) ? p.marketValue - costBasis : undefined;
                const unrealizedPct =
                  unrealized !== undefined && costBasis !== 0 ? (unrealized / Math.abs(costBasis)) * 100 : undefined;
                const protection = deriveProtection(p, snapshot.orders ?? [], snapshot.policy);
                const meta = snapshot.symbolMetaBySymbol?.[p.symbol];
                return (
                  <tr key={p.symbol}>
                    <td>
                      <span className="font-semibold">{p.symbol}</span>
                      {short && (
                        <span className="ml-1.5 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-warn)]">SHORT</span>
                      )}
                      {meta?.companyName && (
                        <span className="block max-w-44 truncate text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                          {meta.companyName}
                        </span>
                      )}
                    </td>
                    <td className="num con-num">{fmtQty(p.quantity)}</td>
                    <td className="num con-num">{fmtMoney(p.averageCost)}</td>
                    <td className="num con-num">{fmtMoney(p.marketValue)}</td>
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
