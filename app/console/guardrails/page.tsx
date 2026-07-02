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
  usePolicyDraft
} from "../components/policy-form";
import {
  ALL_DEFS,
  ENTRY_QUALITY,
  ESSENTIALS,
  EXPOSURE,
  HYGIENE,
  INDICES,
  ORDER_TYPES,
  PANIC_BRAKE,
  SHORTS,
  STOPS_PLUMBING,
  TAX_RULES,
  UNIVERSE_FLOOR
} from "./field-defs";

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
          <AdvancedGroup title="Tax rules">
            <p className="pt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              The wash-sale guard itself (on/off, account type, rates) lives in Settings → Tax treatment. This rule
              tunes how strict the rebuy lockout is for this account.
            </p>
            {TAX_RULES.map((def) => (
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
          <Btn variant="outline" size="sm" onClick={() => setArming((v) => !v)}>
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
          variant="primary"
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
