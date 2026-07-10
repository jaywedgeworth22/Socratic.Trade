"use client";

/** Stop-flow diagram — the graphical "which stop applies when" map that sits above the Protective
 *  stops fields (owner ask, 2026-07-10). Three lanes, each read left → right along its fallback
 *  arrows:
 *   1. DISTANCE — how far the stop sits from entry, per symbol: ATR → beta-scaled → flat base %.
 *   2. TRAILING — the overlay exit that follows the high-water mark (runs alongside lane 1).
 *   3. ENFORCEMENT — who actually fires it: broker-held (survives app downtime) → app monitor.
 *  The model is a pure function of the policy so the on/off/fallback wiring is unit-testable
 *  (test/stop-flow-model.test.ts); the component is presentation only. */

import type { TradingPolicy } from "@/lib/types";

export interface StopFlowNode {
  key: string;
  title: string;
  /** One-line state ("2× ATR(14)", "off", "8% base") rendered under the title. */
  value: string;
  /** Whether this node currently participates for this account. */
  active: boolean;
  /** Hover detail. */
  detail: string;
}

export interface StopFlowLane {
  key: string;
  label: string;
  /** Caption written on the arrows between this lane's nodes (e.g. "no bars ▸"). */
  arrows: string[];
  nodes: StopFlowNode[];
  /** Lane-level footnote. */
  note?: string;
}

/** Pure policy → diagram model. Exported for tests. */
export function stopFlowModel(policy: TradingPolicy): StopFlowLane[] {
  const rules = policy.riskRules ?? {};
  const baseStop = rules.stopLossPct ?? 0;
  const hasBase = baseStop > 0;
  const atrOn = policy.atrStops === true && hasBase;
  const betaOn = policy.betaScaledStops === true && hasBase;
  const trailPct = rules.trailingStopPct ?? 0;
  const trailingOn = trailPct > 0;

  const broker = policy.activeBroker;
  const isAlpaca = broker === "alpaca" || broker === "alpaca-mcp";
  const isRobinhood = broker === "robinhood";
  const bracketsOn = policy.brokerBracketsEnabled !== false && isAlpaca && hasBase;
  const rhStopsOn = policy.robinhoodBrokerStops === true && isRobinhood && hasBase;
  const brokerTrailOn =
    trailingOn &&
    policy.brokerTrailingStops !== false &&
    (isAlpaca || (isRobinhood && policy.robinhoodBrokerStops === true));
  const brokerHeld = bracketsOn || rhStopsOn || brokerTrailOn;

  const distance: StopFlowLane = {
    key: "distance",
    label: "Stop distance — how far below entry, chosen per symbol",
    arrows: ["no price history ▸", "no beta ▸"],
    nodes: [
      {
        key: "atr",
        title: "ATR stop",
        value: atrOn ? `${rules.atrStopMultiple ?? 2}× ATR(${rules.atrStopPeriod ?? 14})` : "off",
        active: atrOn,
        detail: "Distance from the name's own realized daily range. First choice when on; needs recent daily bars."
      },
      {
        key: "beta",
        title: "Beta-scaled",
        value: betaOn ? `${baseStop}% × β (0.5–2×)` : "off",
        active: betaOn,
        detail: "The base % widened for high-beta names and tightened for low-beta ones. Needs a beta from the scan."
      },
      {
        key: "fixed",
        title: "Flat base %",
        value: hasBase ? `−${baseStop}%` : "off — no stop",
        active: hasBase,
        detail: "The always-available floor every other distance rule falls back to. Blanking the field reverts it to the shipped 8% default (it does not disable the stop) — only an explicit 0 turns the per-position stop off entirely."
      }
    ],
    note: hasBase
      ? undefined
      : "No base stop-loss % is set, so ATR/beta have nothing to size — positions carry no per-position stop."
  };

  const trailing: StopFlowLane = {
    key: "trailing",
    label: "Trailing stop — an extra exit riding the high-water mark (runs alongside the stop above)",
    arrows: [],
    nodes: [
      {
        key: "trail",
        title: "Trailing stop",
        value: trailingOn ? `−${trailPct}% from peak` : "off",
        active: trailingOn,
        detail: trailingOn
          ? "Exits when price falls this far from its best level since entry. Both this and the distance stop can fire — whichever triggers first. Shares already committed to a resting broker exit (e.g. Alpaca bracket legs) keep those instead — a trail can't claim shares an existing broker order holds."
          : "Off. Set a trailing % to add a high-water-mark exit on top of the fixed/ATR stop."
      }
    ],
    note: trailingOn && bracketsOn
      ? "Broker-held brackets are also on: bracketed positions keep their bracket stop/take legs (shares can back only one resting exit) — the trail covers unbracketed positions."
      : undefined
  };

  const enforcementParts: string[] = [];
  if (bracketsOn) enforcementParts.push("Alpaca bracket legs");
  // Native trailing_stop orders are an Alpaca REST feature; alpaca-mcp and Robinhood get the
  // app-ratcheted resting stop (see broker-protective-stops.ts).
  if (brokerTrailOn) enforcementParts.push(broker === "alpaca" ? "native trailing stop" : "ratcheted trailing stop");
  if (rhStopsOn && !brokerTrailOn) enforcementParts.push("Robinhood resting stop");

  const enforcement: StopFlowLane = {
    key: "enforcement",
    label: "Who enforces it — first line, then the fallback",
    arrows: ["broker can't hold it ▸"],
    nodes: [
      {
        key: "broker",
        title: "Broker-held",
        value: brokerHeld ? enforcementParts.join(" + ") : "none for this account",
        active: brokerHeld,
        detail:
          "Orders resting at the broker's matching engine — they keep protecting even if this app is down. Availability depends on the broker: Alpaca holds OCO brackets (priced from the same ATR/beta-adjusted distance as the chart above) and native trailing stops; Robinhood holds single resting stops (opt-in)." +
          (rhStopsOn && !brokerTrailOn
            ? " Honest exception: Robinhood's resting fixed stop is priced from the flat base % only — it does NOT pick up ATR/beta-adjusted widening/tightening from the distance lane above."
            : "")
      },
      {
        key: "app",
        title: "App-managed",
        // Honest cadence: fixed/ATR/beta breaches exit via the deterministic risk check at the top
        // of each STRATEGY RUN; only the trailing monitor evaluates on the ~1-minute scheduler
        // tick (and only when a trailing % is set). Saying "every tick" for everything overstated
        // protection for accounts whose broker can't hold the fixed stop.
        value: trailingOn ? "trail: every tick · stops: each strategy run" : "stops: each strategy run",
        active: true,
        detail:
          "The always-on, quantity-aware fallback. Fixed/ATR/beta breaches exit through the deterministic risk check at the start of each strategy run; the trailing monitor evaluates every scheduler tick (~1 min) when a trailing % is set — covering fractional shares, brokers without a needed order type, and anything a broker-held order doesn't. Pauses while the account is Stopped; broker-held orders keep resting."
      }
    ],
    note: "A position's shares can only back ONE resting sell at the broker — the app monitor layers the remaining rules on top."
  };

  return [distance, trailing, enforcement];
}

function NodeBox({ node }: { node: StopFlowNode }) {
  return (
    <div
      title={node.detail}
      className={`min-w-[7.5rem] rounded-md border px-2.5 py-1.5 ${
        node.active
          ? "border-[color:var(--con-pos-border)] bg-[color:var(--con-surface-2)]"
          : "border-[color:var(--con-line)] opacity-55"
      }`}
    >
      <div className="text-[length:var(--con-fs-xs)] font-semibold">{node.title}</div>
      <div className={`con-num text-[length:var(--con-fs-xs)] ${node.active ? "text-[color:var(--con-pos)]" : "text-[color:var(--con-faint)]"}`}>
        {node.value}
      </div>
    </div>
  );
}

function Arrow({ caption }: { caption?: string }) {
  return (
    <div className="flex flex-col items-center px-1 text-[color:var(--con-faint)]">
      {caption ? <span className="text-[10px] leading-tight whitespace-nowrap">{caption}</span> : null}
      <span aria-hidden className="text-[length:var(--con-fs-sm)] leading-none">⟶</span>
    </div>
  );
}

/** The rendered diagram. Pass the account's policy; state comes from stopFlowModel. */
export function StopFlowDiagram({ policy }: { policy: TradingPolicy }) {
  const lanes = stopFlowModel(policy);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface-1)] p-3">
      {lanes.map((lane) => (
        <div key={lane.key}>
          <div className="mb-1.5 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-muted)]">{lane.label}</div>
          <div className="flex flex-wrap items-center gap-y-2">
            {lane.nodes.map((node, i) => (
              <div key={node.key} className="flex items-center">
                {i > 0 && <Arrow caption={lane.arrows[i - 1]} />}
                <NodeBox node={node} />
              </div>
            ))}
          </div>
          {lane.note && (
            <p className="mt-1.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{lane.note}</p>
          )}
        </div>
      ))}
    </div>
  );
}
