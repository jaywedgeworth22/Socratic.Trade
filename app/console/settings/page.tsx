"use client";

/** Settings — GLOBAL-ONLY since the 2026-07-10 IA restructure: everything here
 *  is either ALL YOUR ACCOUNTS (broker connections, API keys, event
 *  notifications, delivery channels, scan shape, learning review, typed
 *  confirmation, boot behavior — user-level, overlaid on every account),
 *  THIS BROWSER (appearance), OPERATOR (admin links), REFERENCE (glossary),
 *  or DANGER (deletion). Nothing account-scoped lives here anymore:
 *  per-account config (models, tax treatment, prompt, weights, guardrails)
 *  belongs to Framework (/console/strategy) and Mandates. Sub-sections live
 *  in sibling modules (brokers/api-keys/delivery/help) with their fetch
 *  helpers in ./lib. */

import { useEffect, useState } from "react";
import { Check, ExternalLink } from "lucide-react";
import type { NotificationEventType } from "@/lib/types";
import { NOTIFICATION_EVENT_TYPES } from "@/lib/types";
import { savePolicy, setAutoResume, ConsoleApiError } from "../lib/api";
import { CONSOLE_PAGE_WIDTH } from "../lib/page-width";
import { useAutoSave } from "../lib/useAutoSave";
import { useConsoleData } from "../lib/useConsoleData";
import { CONSOLE_FONT_OPTIONS, useConsoleFont } from "../lib/useConsoleFont";
import { CONSOLE_TEXT_BOX_FONT_OPTIONS, useConsoleTextBoxFont } from "../lib/useConsoleTextBoxFont";
import { useToast } from "../ui/toast";
import { Card, Chip, Field, RawNumInput, TextInput, Toggle } from "../ui/primitives";
import { List, ListSection, ListRow, LabeledContent } from "../../ui/ios-components";
import { SaveStatus } from "../ui/save-status";
import { ApiKeysCard } from "./api-keys";
import { BrokerAccountsCard } from "./brokers";
import { AccountDeletionCard } from "./danger";
import { DeliveryChannelsCard } from "./delivery";
import { HelpGlossaryCard } from "./help";
import { LearningReviewCard } from "./learning-review";
import { DataSharingCard } from "./sharing";

const EVENT_HINT: Partial<Record<NotificationEventType, string>> = {
  fill: "an order filled",
  block: "the policy gate blocked an order",
  run_failed: "a strategy run failed",
  pending_approval: "a trade is waiting for you",
  kill_switch: "a circuit breaker fired",
  price_alert: "a price alert triggered",
  proposal_withdrawn: "the strategist took an idea back",
  limit_order_stale: "a limit order has been working too long",
  provider_degraded: "a data provider is failing",
  budget_alert: "a usage budget threshold was crossed",
  learning_review: "the daily learning review posted its findings"
};

export default function SettingsPage() {
  const { snapshot } = useConsoleData();
  const ready = snapshot !== null;

  // Deep links (e.g. the Run-once blocked sheet routes to /console/settings#api-keys):
  // the page renders only after the snapshot arrives, so the native anchor jump
  // misses — scroll once the target section actually exists.
  useEffect(() => {
    if (!ready || typeof window === "undefined") return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const timer = setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    return () => clearTimeout(timer);
  }, [ready]);

  if (!snapshot) return null;

  return (
    <div className={`${CONSOLE_PAGE_WIDTH} flex flex-col gap-6`}>
      <h1 className="text-[length:var(--con-fs-lg)] font-bold px-4 lg:px-0">Settings</h1>

      {/* Account-scoped config (models, tax treatment, prompt, weights) lives on
          Framework (/console/strategy) and Mandates — Settings is global-only. */}

      <List>
        {/* ── ALL ACCOUNTS ── */}
        <ListSection title="ALL YOUR ACCOUNTS" footer="Settings tagged ALL YOUR ACCOUNTS are stored per user — they overlay every account you connect, in every scope.">
          {/* Anchor ids (#brokers/#api-keys) are deep-link targets used by the
              Run-once blocked-reason sheet; scroll-mt clears the sticky chrome. */}
          <div id="brokers" className="scroll-mt-28">
            <BrokerAccountsCard />
          </div>
          <div id="api-keys" className="scroll-mt-28">
            <ApiKeysCard />
          </div>
          <EventNotificationsCard />
          <DeliveryChannelsCard />
          <div id="sharing" className="scroll-mt-28">
            <DataSharingCard />
          </div>
          <ScanShapeCard />
          <div id="learning-review" className="scroll-mt-28">
            <LearningReviewCard />
          </div>
          <div id="confirmation" className="scroll-mt-28">
            <AdvancedActionConfirmationCard />
          </div>
          <BootBehaviorCard />
          <YouCard />
        </ListSection>

        {/* ── THIS BROWSER ── */}
        <ListSection title="THIS BROWSER" footer="Settings tagged THIS BROWSER are stored in this browser only. They change how the console looks here, not how the strategy trades.">
          <AppearanceCard />
        </ListSection>

        {/* ── OPERATOR (admin only: links, no new admin UI) ── */}
        {snapshot.currentUser?.isAdmin && (
          <div id="admin" className="scroll-mt-28">
            <ListSection title="OPERATOR" footer="Visible because this login has operator/admin rights on the server. Server-wide diagnostics, outside the console.">
              <AdminLinksCard />
            </ListSection>
          </div>
        )}

        {/* ── REFERENCE ── */}
        <ListSection title="REFERENCE" footer="Nothing here changes any setting — it's the app's vocabulary, searchable.">
          <HelpGlossaryCard />
        </ListSection>

        {/* ── DANGER ── */}
        <div id="danger" className="scroll-mt-28">
          <ListSection title="DANGER" footer="Irreversible actions live here, behind typed confirmations — nothing in this section happens by accident.">
            <AccountDeletionCard />
          </ListSection>
        </div>
      </List>
    </div>
  );
}

// ── All accounts: typed confirmation for high-impact live actions ────────────

function AdvancedActionConfirmationCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  // Default ON (undefined => required). Real money is normal, but the phrase stays available as an
  // owner preference — this switch turns it off so approvals / replacements / loosening are one click.
  const required = snapshot?.policy.requireTypedConfirmation !== false;
  const setRequired = async (next: boolean) => {
    setSaving(true);
    try {
      await savePolicy({ requireTypedConfirmation: next });
      await refresh();
      toast.push(
        "pos",
        next ? "Typed confirmation on" : "Typed confirmation off",
        next
          ? "Approving a broker order, replacing a live order, and loosening a guardrail ask you to type the phrase first."
          : "Those are now ordinary one-click actions. Winding down (which sells) and account deletion still confirm."
      );
    } catch (error) {
      toast.push("neg", "Couldn't save", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <ListSection title="Advanced action confirmation" footer="One switch for your whole login — it applies across every account you connect. On: approving a broker order, replacing a live order at market, and loosening a guardrail on a live account each ask you to type a short phrase (e.g. APPROVE LIVE NVDA) first. Off: they are one click. Winding down (which SELLS) and deleting an account always keep their own typed confirmation regardless.">
      <ListRow>
        <LabeledContent label="Require typed confirmation" hint={required ? "On — type to confirm" : "Off — one click"}>
          <Toggle
            checked={required}
            onChange={(next) => void setRequired(next)}
            disabled={saving}
          />
        </LabeledContent>
      </ListRow>
    </ListSection>
  );
}

// ── This browser: local appearance preferences ──────────────────────────────

/** Shared button-grid for the two font pickers below — same idiom, different
 *  option list/selection/setter. */
function FontOptionGrid<F extends string>({
  options,
  selected,
  onSelect
}: {
  options: Array<{ value: F; label: string; description: string; fontFamily: string }>;
  selected: F;
  onSelect: (next: F) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((option) => {
        const isSelected = selected === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={isSelected}
            title={option.description}
            onClick={() => onSelect(option.value)}
            className={`min-h-[88px] rounded-lg border px-3 py-2 text-left transition-colors ${
              isSelected
                ? "border-[color:var(--con-accent)] bg-[color:var(--con-accent-soft)]"
                : "border-[color:var(--con-line-strong)] bg-[color:var(--con-surface-2)] hover:border-[color:var(--con-accent-border)]"
            }`}
          >
            <span className="flex items-center justify-between gap-2 text-[length:var(--con-fs-sm)] font-semibold text-[color:var(--con-fg)]">
              {option.label}
              {isSelected && <Check size={14} className="text-[color:var(--con-accent)]" aria-hidden />}
            </span>
            <span
              className="mt-1 block max-h-[44px] overflow-hidden text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]"
              style={{ fontFamily: option.fontFamily }}
            >
              Objective: compound returns by rotating capital toward the strongest risk-adjusted opportunities.
            </span>
          </button>
        );
      })}
    </div>
  );
}

function AppearanceCard() {
  const { textBoxFont, setTextBoxFont } = useConsoleTextBoxFont();
  const { consoleFont, setConsoleFont } = useConsoleFont();
  return (
    <ListSection title="Appearance" footer="The whole console uses this font in this browser.">
      <ListRow>
        <div className="flex flex-col gap-3 w-full py-2">
          <div className="text-[length:var(--con-fs-sm)] font-semibold">Console Font</div>
          <FontOptionGrid options={CONSOLE_FONT_OPTIONS} selected={consoleFont} onSelect={setConsoleFont} />
        </div>
      </ListRow>
      <ListRow>
        <div className="flex flex-col gap-3 w-full py-2">
          <div className="text-[length:var(--con-fs-sm)] font-semibold">Text Box Font</div>
          <FontOptionGrid options={CONSOLE_TEXT_BOX_FONT_OPTIONS} selected={textBoxFont} onSelect={setTextBoxFont} />
        </div>
      </ListRow>
    </ListSection>
  );
}

// ── Operator/admin links (links only — the pages themselves live at /admin) ──

const ADMIN_LINKS: Array<{ href: string; label: string; desc: string }> = [
  { href: "/admin/connections", label: "API connections health", desc: "Live status of every upstream data/broker connection the server uses." },
  { href: "/admin/llm-usage", label: "LLM usage & cost", desc: "Token and dollar spend per model and per day, across all users." },
  { href: "/admin/rag-coverage", label: "RAG coverage", desc: "What the retrieval index covers and where it is thin." },
  { href: "/admin/transcript", label: "Chat transcript", desc: "Raw assistant transcript view for debugging conversations." }
];

function AdminLinksCard() {
  return (
    <ListSection title="Admin pages" footer="Operator diagnostics from the legacy app — they open outside the console and keep their own styling.">
      {ADMIN_LINKS.map((link) => (
        <ListRow key={link.href}>
          <a
            href={link.href}
            className="flex items-center justify-between w-full text-[length:var(--con-fs-sm)] py-1"
            title={`${link.desc} Opens outside the console.`}
          >
            <div className="flex flex-col min-w-0">
              <span className="font-medium text-[color:var(--con-fg)]">{link.label}</span>
              <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)] truncate">{link.desc}</span>
            </div>
            <ExternalLink size={16} className="shrink-0 text-[color:var(--con-muted)] ml-3" />
          </a>
        </ListRow>
      ))}
    </ListSection>
  );
}

// ── All accounts: event notifications (user-level policy field) ─────────────

function EventNotificationsCard() {
  const { snapshot, refresh } = useConsoleData();
  const autoSave = useAutoSave();
  // Sticky optimistic local state: seeded lazily from the snapshot, updated on
  // change for instant feedback, reverted by useAutoSave's onError if the write
  // fails. refresh() keeps the shared snapshot current for the rest of the app.
  const [localEvents, setLocalEvents] = useState<NotificationEventType[] | null>(null);
  const [localWebhook, setLocalWebhook] = useState<string | null>(null);
  if (!snapshot) return null;

  const current = snapshot.policy.notificationSettings;
  const events = localEvents ?? current.enabledEvents;
  const webhook = localWebhook ?? current.webhookUrl ?? "";

  const toggleEvent = (type: NotificationEventType, on: boolean) => {
    const prev = events;
    const next = on ? events.filter((e) => e !== type) : [...events, type];
    setLocalEvents(next);
    autoSave.save(() => savePolicy({ notificationSettings: { enabledEvents: next } }).then(() => refresh()), {
      onError: () => setLocalEvents(prev)
    });
  };

  const commitWebhook = () => {
    const next = webhook.trim();
    if (next === (current.webhookUrl ?? "")) return; // unchanged → no write
    const prev = webhook;
    // Server validates (400 on a non-URL); revert the field on failure.
    autoSave.save(() => savePolicy({ notificationSettings: { webhookUrl: next } }).then(() => refresh()), {
      onError: () => setLocalWebhook(prev),
      errorTitle: "Webhook not saved"
    });
  };

  return (
    <ListSection 
      title="Event notifications" 
      footer="Which events send notifications, and the webhook they go to. One list for your whole login — it applies across every account."
      action={<SaveStatus status={autoSave.status} />}
    >
      {NOTIFICATION_EVENT_TYPES.map((type) => {
        const on = events.includes(type);
        return (
          <ListRow key={type}>
            <LabeledContent label={type} hint={EVENT_HINT[type]}>
              <Toggle
                checked={on}
                disabled={autoSave.saving}
                onChange={() => toggleEvent(type, on)}
              />
            </LabeledContent>
          </ListRow>
        );
      })}
      <ListRow>
        <LabeledContent label="Webhook URL" hint="Rich embeds for chat webhooks; generic JSON otherwise.">
          <input
            id="webhook"
            className="w-48 text-right bg-transparent text-[length:var(--con-fs-sm)] focus:outline-none placeholder:text-[color:var(--con-muted)]"
            value={webhook}
            placeholder="https://…"
            title="Every enabled event is also POSTed to this URL."
            onChange={(e) => setLocalWebhook(e.target.value)}
            onBlur={commitWebhook}
          />
        </LabeledContent>
      </ListRow>
    </ListSection>
  );
}

// ── All accounts: scan shape ─────────────────────────────────────────────────

function ScanShapeCard() {
  const { snapshot, refresh } = useConsoleData();
  const autoSave = useAutoSave();
  const [draft, setDraft] = useState<{ marketScanCandidateLimit?: number; marketScanOutlierReserve?: number }>({});
  if (!snapshot) return null;

  const policy = snapshot.policy;
  const candidateLimit = draft.marketScanCandidateLimit ?? policy.marketScanCandidateLimit;
  const outlierReserve = draft.marketScanOutlierReserve ?? policy.marketScanOutlierReserve;

  // Numeric fields: local text while typing, persist on blur. `key` is a top-level
  // policy field (whole-replace), not a nested object.
  const commitNumber = (key: "marketScanCandidateLimit" | "marketScanOutlierReserve", next: number | undefined, saved: number | undefined) => {
    if (next === saved) return; // unchanged → no write
    autoSave.save(() => savePolicy({ [key]: next }).then(() => refresh()), {
      onError: () => setDraft((d) => ({ ...d, [key]: saved }))
    });
  };

  return (
    <ListSection 
      title="Market-scan shape" 
      footer="How wide every account's market scan looks. These two are user-level."
      action={<SaveStatus status={autoSave.status} />}
    >
      <ListRow>
        <LabeledContent label="Enriched candidates" hint="Ranked names that get full enrichment per run.">
          <RawNumInput
            id="scan-limit"
            className="w-20 text-right bg-transparent border-0 px-0 text-[length:var(--con-fs-sm)] focus:ring-0"
            value={String(candidateLimit ?? "")}
            emptyValue={0}
            onValueChange={(parsed) => setDraft((d) => ({ ...d, marketScanCandidateLimit: parsed }))}
            onBlur={() => commitNumber("marketScanCandidateLimit", candidateLimit, policy.marketScanCandidateLimit)}
          />
        </LabeledContent>
      </ListRow>
      <ListRow>
        <LabeledContent label="Outlier reserve" hint="Below-cutoff slots reserved for notable web signals.">
          <RawNumInput
            id="scan-reserve"
            className="w-20 text-right bg-transparent border-0 px-0 text-[length:var(--con-fs-sm)] focus:ring-0"
            value={String(outlierReserve ?? "")}
            emptyValue={0}
            onValueChange={(parsed) => setDraft((d) => ({ ...d, marketScanOutlierReserve: parsed }))}
            onBlur={() => commitNumber("marketScanOutlierReserve", outlierReserve, policy.marketScanOutlierReserve)}
          />
        </LabeledContent>
      </ListRow>
    </ListSection>
  );
}

// ── All accounts: boot behavior ──────────────────────────────────────────────

function BootBehaviorCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!snapshot) return null;

  return (
    <ListSection title="After a restart" footer="Off (recommended): whenever the server restarts, any Running account is stopped until a person starts it again. Turning this ON removes that safety net.">
      <ListRow>
        <LabeledContent label="Auto-resume on boot">
          <Toggle
            checked={snapshot.autoResumeOnBoot}
            onChange={async (next) => {
              setBusy(true);
              try {
                await setAutoResume(next);
                await refresh();
                toast.push(next ? "warn" : "pos", next ? "Auto-resume ON" : "Auto-resume off", next ? "Accounts left Running will resume by themselves after a restart." : "Restarts stop everything until you start it again.");
              } catch (error) {
                toast.push("neg", "Not saved", error instanceof ConsoleApiError ? error.message : String(error));
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          />
        </LabeledContent>
      </ListRow>
    </ListSection>
  );
}

// ── You ──────────────────────────────────────────────────────────────────────

function YouCard() {
  const { snapshot } = useConsoleData();
  if (!snapshot?.currentUser) return null;
  const user = snapshot.currentUser;
  return (
    <ListSection title="You">
      <ListRow>
        <LabeledContent label={user.name ?? user.email ?? user.userId} hint={user.email && user.name ? user.email : undefined}>
          <div className="flex items-center gap-2">
            {user.isAdmin && (
              <Chip tone="accent">
                admin
              </Chip>
            )}
            {user.loginProvider && (
              <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
                via {user.loginProvider}
              </span>
            )}
          </div>
        </LabeledContent>
      </ListRow>
    </ListSection>
  );
}
