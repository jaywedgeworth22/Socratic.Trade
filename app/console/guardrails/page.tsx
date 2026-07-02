"use client";

/** Guardrails — the deterministic cage, essentials first (max order, daily
 *  caps, stop-loss, daily-loss breaker, autonomy, extended hours), then the
 *  advanced rulebook grouped the way the domain groups it. Editing uses a
 *  review-and-commit model with asymmetric friction: tightening is one click,
 *  loosening on LIVE money requires typing CONFIRM. Autonomy has its own
 *  ritual: Autopilot costs a typed word, going back to Ask-first is one tap. */

import { useMemo, useState } from "react";
import type { IndexUniverse, OrderType } from "@/lib/types";
import { savePolicy, ConsoleApiError, type PolicyPatchBody } from "../lib/api";
import { deriveReality } from "../lib/derive";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { Btn, Card, Chip, Field, Select, TextInput } from "../ui/primitives";
import { TypedConfirm } from "../components/chrome";
import {
  AdvancedGroup,
  PolicyFieldRow,
  PolicySaveBar,
  usePolicyDraft,
  type FieldDef
} from "../components/policy-form";

// ── Field metadata (labels + honest one-liners + loosening direction) ────────

const ESSENTIALS: FieldDef[] = [
  { path: "maxOrderNotional", label: "Max per order", kind: "money", optional: true, looserWhen: "up", hint: "Hard dollar cap on any single order. Blank = no per-order dollar cap (the % of portfolio cap below still applies)." },
  { path: "maxOrderPctOfNav", label: "Max per order (% of portfolio)", kind: "pct", optional: true, looserWhen: "up" },
  { path: "maxDailyNotional", label: "Max spend per day", kind: "money", optional: true, looserWhen: "up", hint: "Opening orders only — protective exits never consume this cap." },
  { path: "maxDailyOrders", label: "Max opening orders per day", kind: "int", looserWhen: "up" },
  { path: "riskRules.stopLossPct", label: "Stop-loss", kind: "pct", optional: true, looserWhen: "up", hint: "Sell automatically if a position drops this far. Wider = looser protection." },
  { path: "riskRules.takeProfitPct", label: "Take profit at", kind: "pct", optional: true },
  { path: "riskRules.takeProfitTrimPct", label: "Take-profit trim", kind: "pct", optional: true, hint: "How much of the position to sell when take-profit triggers (100 = full exit)." },
  { path: "riskRules.maxDailyLossNotional", label: "Daily loss stop", kind: "money", optional: true, looserWhen: "up", hint: "Circuit breaker: if the account loses this much in a day, new buys stop automatically (Exit-only). Protective sells keep working." },
  { path: "riskRules.maxDrawdownPct", label: "Max drawdown stop", kind: "pct", optional: true, looserWhen: "up", hint: "Circuit breaker on the fall from the account's high-water mark." },
  { path: "runCadenceMinutes", label: "Run every", kind: "minutes" },
  { path: "runDuringExtendedHours", label: "Run during extended hours", kind: "bool", looserWhen: "on" },
  { path: "permitExtendedHours", label: "Allow extended-hours orders", kind: "bool", looserWhen: "on" }
];

const EXPOSURE: FieldDef[] = [
  { path: "maxSymbolExposurePct", label: "Max in one stock (%)", kind: "pct", optional: true, looserWhen: "up" },
  { path: "maxSymbolExposureNotional", label: "Max in one stock ($)", kind: "money", optional: true, looserWhen: "up" },
  { path: "maxGrossExposurePct", label: "Max gross exposure (%)", kind: "pct", optional: true, looserWhen: "up" },
  { path: "maxNetExposurePct", label: "Max net exposure (%)", kind: "pct", optional: true, looserWhen: "up" },
  { path: "maxPortfolioBeta", label: "Max portfolio beta", kind: "int", optional: true, looserWhen: "up", hint: "Risk-reducing trades always pass." },
  { path: "maxAvgCorrelation", label: "Max avg correlation (0–1)", kind: "int", optional: true, looserWhen: "up", hint: "Skips opening a name too correlated with current holdings. Never blocks exits." },
  { path: "maxOrderPctOfAdv", label: "Max order vs daily volume (%)", kind: "pct", optional: true, looserWhen: "up", hint: "Market-impact cap: an opening order may not exceed this share of the name's recent daily dollar volume." }
];

const ENTRY_QUALITY: FieldDef[] = [
  { path: "maxEntryDriftPct", label: "Max entry drift (%)", kind: "pct", optional: true, looserWhen: "up", hint: "Rejects a stale opening order whose price moved this far from where the idea was priced." },
  { path: "maxQuoteAgeSec", label: "Max quote age", kind: "seconds", optional: true, looserWhen: "up", hint: "Opening orders blocked on stale quotes. Blank = gate off. Missing timestamps count as stale when on." },
  { path: "maxFundamentalsAgeSec", label: "Max fundamentals age", kind: "seconds", optional: true, looserWhen: "up" },
  { path: "marketableLimitEntries", label: "Marketable-limit entries", kind: "bool", hint: "Converts opening market orders to tightly-priced limits so a fast tape can't fill arbitrarily far past the quote." }
];

const STOPS_PLUMBING: FieldDef[] = [
  { path: "riskRules.trailingStopPct", label: "Trailing stop", kind: "pct", optional: true },
  { path: "brokerBracketsEnabled", label: "Broker-held brackets", kind: "bool", hint: "Stop/take-profit legs rest at the broker (where supported) so protection survives app downtime. Turning this OFF is looser.", looserWhen: "on" },
  { path: "robinhoodBrokerStops", label: "Robinhood resting stops", kind: "bool", hint: "Opt-in true broker-side stop for live Robinhood positions." },
  { path: "betaScaledStops", label: "Beta-scaled stops", kind: "bool", hint: "Stop distance scaled by the name's beta (clamped 0.5–2.0×)." },
  { path: "atrStops", label: "ATR-based stops", kind: "bool", hint: "Stop distance from the name's own realized daily range instead of a flat %." },
  { path: "riskRules.atrStopPeriod", label: "ATR period", kind: "int", optional: true },
  { path: "riskRules.atrStopMultiple", label: "ATR multiple", kind: "int", optional: true },
  { path: "allowExtendedHoursSyntheticStops", label: "App stops in extended hours", kind: "bool", looserWhen: "on" }
];

const PANIC_BRAKE: FieldDef[] = [
  { path: "volPanicBrakeEnabled", label: "Volatility panic brake", kind: "bool", looserWhen: "on", hint: "A rare tail-extreme reading on VIX/VVIX/SKEW flips the system to Exit-only automatically. Turning OFF is looser." },
  { path: "volPanicVixThreshold", label: "VIX threshold", kind: "int", optional: true, looserWhen: "up" },
  { path: "volPanicVvixThreshold", label: "VVIX threshold", kind: "int", optional: true, looserWhen: "up" },
  { path: "volPanicSkewThreshold", label: "SKEW threshold", kind: "int", optional: true, looserWhen: "up" }
];

const SHORTS: FieldDef[] = [
  { path: "shortSellingEnabled", label: "Short selling", kind: "bool", looserWhen: "on", hint: "Also requires the broker to allow shorting on this account. Every short must carry a short stop-loss." },
  { path: "maxShortOrderNotional", label: "Max short order", kind: "money", optional: true, looserWhen: "up" },
  { path: "maxShortExposurePct", label: "Max short exposure (%)", kind: "pct", optional: true, looserWhen: "up" },
  { path: "riskRules.shortStopLossPct", label: "Short stop-loss", kind: "pct", optional: true, looserWhen: "up", hint: "Mandatory for any short — a short without one is rejected." }
];

const HYGIENE: FieldDef[] = [
  { path: "maxProposalsPerRun", label: "Max ideas per run", kind: "int", looserWhen: "up" },
  { path: "maxHourlyNotional", label: "Max spend per hour", kind: "money", optional: true, looserWhen: "up", hint: "Rolling 60-minute ceiling. Breaching it auto-demotes the account back to Ask-first." },
  { path: "proposalExpiryMinutes", label: "Proposal expiry", kind: "minutes", optional: true, hint: "Pending proposals older than this auto-expire. 0/blank = no hard expiry." },
  { path: "proposalRevalidateCadenceHours", label: "Re-validate pending ideas every (hours)", kind: "int", optional: true, hint: "0 = every run." },
  { path: "staleLimitOrderMinutes", label: "Stale limit-order alert (minutes)", kind: "int", optional: true }
];

const UNIVERSE_FLOOR: FieldDef[] = [
  { path: "universeFloor.minPrice", label: "Min share price", kind: "money", optional: true, looserWhen: "down", hint: "The penny-stock gate. Held positions and your explicit symbols are always exempt; exits never affected." },
  { path: "universeFloor.minMarketCapUsd", label: "Min market cap", kind: "money", optional: true, looserWhen: "down" },
  { path: "universeFloor.minDollarVolume", label: "Min daily dollar volume", kind: "money", optional: true, looserWhen: "down" }
];

const ALL_DEFS: FieldDef[] = [
  ...ESSENTIALS,
  ...EXPOSURE,
  ...ENTRY_QUALITY,
  ...STOPS_PLUMBING,
  ...PANIC_BRAKE,
  ...SHORTS,
  ...HYGIENE,
  ...UNIVERSE_FLOOR
];

const INDICES: Array<{ id: IndexUniverse; label: string }> = [
  { id: "sp100", label: "S&P 100" },
  { id: "sp500", label: "S&P 500" },
  { id: "nasdaq100", label: "Nasdaq 100" },
  { id: "nasdaqComposite", label: "Nasdaq Composite" },
  { id: "dow30", label: "Dow 30" },
  { id: "russell2000", label: "Russell 2000" },
  { id: "nyseComposite", label: "NYSE Composite" },
  { id: "ftWilshire5000", label: "FT Wilshire 5000" }
];

const ORDER_TYPES: OrderType[] = ["market", "limit", "stop_market", "stop_limit"];

function parseSymbols(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export default function GuardrailsPage() {
  const { snapshot } = useConsoleData();
  const draft = usePolicyDraft();
  const [universeDraft, setUniverseDraft] = useState<{
    includedIndices?: IndexUniverse[];
    additionalSymbols?: string;
    blocklist?: string;
    permittedOrderTypes?: OrderType[];
    sellToFundBuy?: string;
  }>({});

  const reality = useMemo(() => (snapshot ? deriveReality(snapshot) : null), [snapshot]);
  if (!snapshot || !reality) return null;
  const policy = snapshot.policy;

  // Universe / arrays are replace-whole-value fields → extraPatch.
  const extraPatch: PolicyPatchBody = {};
  if (universeDraft.includedIndices && universeDraft.includedIndices.join() !== policy.includedIndices.join()) {
    extraPatch.includedIndices = universeDraft.includedIndices;
  }
  if (universeDraft.additionalSymbols !== undefined && parseSymbols(universeDraft.additionalSymbols).join() !== (policy.additionalSymbols ?? []).join()) {
    extraPatch.additionalSymbols = parseSymbols(universeDraft.additionalSymbols);
  }
  if (universeDraft.blocklist !== undefined && parseSymbols(universeDraft.blocklist).join() !== (policy.blocklist ?? []).join()) {
    extraPatch.blocklist = parseSymbols(universeDraft.blocklist);
  }
  if (universeDraft.permittedOrderTypes && universeDraft.permittedOrderTypes.join() !== policy.permittedOrderTypes.join()) {
    extraPatch.permittedOrderTypes = universeDraft.permittedOrderTypes;
  }
  if (universeDraft.sellToFundBuy !== undefined && universeDraft.sellToFundBuy !== (policy.sellToFundBuy ?? "off")) {
    extraPatch.sellToFundBuy = universeDraft.sellToFundBuy;
  }

  const indices = universeDraft.includedIndices ?? policy.includedIndices;
  const orderTypes = universeDraft.permittedOrderTypes ?? policy.permittedOrderTypes;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[length:var(--con-fs-lg)] font-bold">Guardrails</h1>
        <Chip tone={reality.tone}>
          {reality.word} · {reality.phrase}
        </Chip>
        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          for {reality.account?.label ?? "the local simulator"} — deterministic limits the strategist can never exceed
        </span>
      </div>

      <AutonomyCard />

      <Card title="Essentials">
        <div className="divide-y divide-[color:var(--con-line)]">
          {ESSENTIALS.map((def) => (
            <PolicyFieldRow key={def.path} def={def} policy={policy} draft={draft} />
          ))}
        </div>
      </Card>

      <Card title="Advanced rulebook" padded={false}>
        <div className="px-4 pb-2">
          <p className="pt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            Everything below ships with safe defaults — you never have to touch it. One rule everywhere: a cap that
            demanded an exit can never block that exit.
          </p>
          <AdvancedGroup title="Exposure caps">
            {EXPOSURE.map((def) => (
              <PolicyFieldRow key={def.path} def={def} policy={policy} draft={draft} />
            ))}
          </AdvancedGroup>
          <AdvancedGroup title="Entry quality gates">
            {ENTRY_QUALITY.map((def) => (
              <PolicyFieldRow key={def.path} def={def} policy={policy} draft={draft} />
            ))}
          </AdvancedGroup>
          <AdvancedGroup title="Protective stops plumbing">
            {STOPS_PLUMBING.map((def) => (
              <PolicyFieldRow key={def.path} def={def} policy={policy} draft={draft} />
            ))}
          </AdvancedGroup>
          <AdvancedGroup title="Volatility panic brake">
            {PANIC_BRAKE.map((def) => (
              <PolicyFieldRow key={def.path} def={def} policy={policy} draft={draft} />
            ))}
          </AdvancedGroup>
          <AdvancedGroup title="Short selling">
            {SHORTS.map((def) => (
              <PolicyFieldRow key={def.path} def={def} policy={policy} draft={draft} />
            ))}
          </AdvancedGroup>
          <AdvancedGroup title="Proposal hygiene & pace">
            {HYGIENE.map((def) => (
              <PolicyFieldRow key={def.path} def={def} policy={policy} draft={draft} />
            ))}
          </AdvancedGroup>
          <AdvancedGroup title="Universe">
            <div className="py-2">
              <div className="con-label">Base indices</div>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                {INDICES.map((idx) => {
                  const on = indices.includes(idx.id);
                  return (
                    <label key={idx.id} className="flex cursor-pointer items-center gap-2 text-[length:var(--con-fs-sm)]">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setUniverseDraft((d) => ({
                            ...d,
                            includedIndices: on ? indices.filter((i) => i !== idx.id) : [...indices, idx.id]
                          }))
                        }
                      />
                      {idx.label}
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="grid gap-3 py-2 sm:grid-cols-2">
              <Field label="Always include (symbols)" hint="Comma or space separated. Exempt from the universe floor." htmlFor="add-syms">
                <TextInput
                  id="add-syms"
                  value={universeDraft.additionalSymbols ?? (policy.additionalSymbols ?? []).join(", ")}
                  onChange={(e) => setUniverseDraft((d) => ({ ...d, additionalSymbols: e.target.value }))}
                />
              </Field>
              <Field label="Never touch (blocklist)" hint="Blocking a stock never blocks selling it — exits are always allowed." htmlFor="block-syms">
                <TextInput
                  id="block-syms"
                  value={universeDraft.blocklist ?? (policy.blocklist ?? []).join(", ")}
                  onChange={(e) => setUniverseDraft((d) => ({ ...d, blocklist: e.target.value }))}
                />
              </Field>
            </div>
            {UNIVERSE_FLOOR.map((def) => (
              <PolicyFieldRow key={def.path} def={def} policy={policy} draft={draft} />
            ))}
            <div className="py-2">
              <div className="con-label">Permitted order types</div>
              <div className="flex flex-wrap gap-3">
                {ORDER_TYPES.map((t) => {
                  const on = orderTypes.includes(t);
                  return (
                    <label key={t} className="flex cursor-pointer items-center gap-2 text-[length:var(--con-fs-sm)]">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setUniverseDraft((d) => ({
                            ...d,
                            permittedOrderTypes: on ? orderTypes.filter((x) => x !== t) : [...orderTypes, t]
                          }))
                        }
                      />
                      {t.replace("_", " ")}
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="max-w-xs py-2">
              <Field
                label="Sell-to-fund buys"
                hint="How to raise cash when intended buys exceed buying power. Off = never."
                htmlFor="stf"
              >
                <Select
                  id="stf"
                  value={universeDraft.sellToFundBuy ?? policy.sellToFundBuy ?? "off"}
                  onChange={(e) => setUniverseDraft((d) => ({ ...d, sellToFundBuy: e.target.value }))}
                >
                  <option value="off">off</option>
                  <option value="suggest">suggest</option>
                  <option value="propose">propose (asks you)</option>
                  <option value="automated">automated</option>
                </Select>
              </Field>
            </div>
          </AdvancedGroup>
        </div>
      </Card>

      <PolicySaveBar
        policy={policy}
        draft={draft}
        defs={ALL_DEFS}
        reality={reality}
        extraPatch={Object.keys(extraPatch).length > 0 ? extraPatch : undefined}
      />
    </div>
  );
}

/** Autonomy is not a slider in the save-bar — it gets its own asymmetric
 *  ritual. Ask-first is one tap; Autopilot costs typing the word. */
function AutonomyCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [arming, setArming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!snapshot) return null;
  const reality = deriveReality(snapshot);
  const decide = snapshot.policy.strategyAuthority === "decide";

  const setAuthority = async (authority: "propose" | "decide") => {
    setBusy(true);
    try {
      await savePolicy({ strategyAuthority: authority });
      await refresh();
      setArming(false);
      setTyped("");
      toast.push(
        authority === "decide" ? "warn" : "pos",
        authority === "decide" ? "Autopilot on" : "Back to Ask-first",
        authority === "decide"
          ? "The strategy may place orders itself — still inside every guardrail on this page."
          : "Every trade now waits for your approval."
      );
    } catch (error) {
      toast.push("neg", "Authority not changed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Autonomy">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[length:var(--con-fs-md)] font-semibold">{decide ? "Autopilot" : "Ask-first"}</div>
          <p className="mt-0.5 max-w-xl text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
            {decide
              ? "The strategy may place orders itself, inside every limit on this page. High-conviction ideas whose adversarial review couldn't run still come to you. Breaching the hourly cap demotes it back to Ask-first automatically. A server restart stops it until a person starts it again."
              : "The strategy only suggests. Nothing is traded until you approve each idea. Most people stay here."}
          </p>
        </div>
        {decide ? (
          <Btn variant="pos" size="sm" disabled={busy} onClick={() => void setAuthority("propose")}>
            {busy ? "Switching…" : "Switch to Ask-first"}
          </Btn>
        ) : (
          <Btn variant="dangerOutline" size="sm" onClick={() => setArming((v) => !v)}>
            Turn on Autopilot…
          </Btn>
        )}
      </div>
      {!decide && arming && (
        <TypedConfirm
          phrase="AUTOPILOT"
          value={typed}
          onChange={setTyped}
          busy={busy}
          confirmLabel="Enable Autopilot"
          note={
            reality.tone === "live"
              ? "This is a LIVE (real money) account. With Autopilot on, orders can spend real capital without a per-trade approval — still bounded by every guardrail. Turning autonomy ON costs typing; turning it OFF never does."
              : "Autopilot lets the strategy place practice-money orders itself, inside your guardrails. Turning it on costs typing; turning it off never does."
          }
          onConfirm={() => void setAuthority("decide")}
        />
      )}
    </Card>
  );
}
