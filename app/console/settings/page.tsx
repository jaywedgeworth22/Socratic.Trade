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
import { SaveStatus } from "../ui/save-status";
import { ApiKeysCard } from "./api-keys";
import { BrokerAccountsCard } from "./brokers";
import { AccountDeletionCard } from "./danger";
import { DeliveryChannelsCard } from "./delivery";
import { HelpGlossaryCard } from "./help";
import { LearningReviewCard } from "./learning-review";
import { DataSharingCard } from "./sharing";

/** Plain-English name + one-line meaning for every notification event. The raw
 *  snake_case type is an internal identifier and must never be user-facing.
 *  A full Record (not Partial) so adding a NotificationEventType without copy
 *  here is a compile error instead of a raw "run_failed" label in production.
 *  Hints complete the sentence "you get a notification whenever ...". */
const EVENT_META: Record<NotificationEventType, { label: string; hint: string }> = {
  fill: { label: "Order filled", hint: "an order filled" },
  block: { label: "Order blocked", hint: "the policy gate blocked an order" },
  run_failed: { label: "Run failed", hint: "a strategy run failed" },
  pending_approval: { label: "Pending approval", hint: "a trade is waiting for you" },
  kill_switch: { label: "Kill switch fired", hint: "a circuit breaker fired" },
  price_alert: { label: "Price alert", hint: "a price alert triggered" },
  proposal_withdrawn: { label: "Proposal withdrawn", hint: "the strategist took an idea back" },
  limit_order_stale: { label: "Stale limit order", hint: "a limit order has been working too long" },
  provider_degraded: { label: "Data provider degraded", hint: "a data provider is failing" },
  budget_alert: { label: "Budget alert", hint: "a usage budget threshold was crossed" },
  learning_review: { label: "Learning review", hint: "the daily learning review posted its findings" },
  deterministic_bear_veto: { label: "Bear risk veto", hint: "the rule-based bear check vetoed a trade idea" },
  red_team_veto_override_requested: {
    label: "Red Team override requested",
    hint: "an override of a Red Team veto was requested"
  },
  red_team_veto_overridden: { label: "Red Team veto overridden", hint: "a human overrode a Red Team veto" },
  prompt_injection_suspected: {
    label: "Prompt injection suspected",
    hint: "injection-like text was found in the evidence sent to the model"
  },
  evidence_age_anomaly: { label: "Stale evidence", hint: "a run leaned on evidence older than it should be" },
  storage_warning: { label: "Storage warning", hint: "the server's database storage crossed a warning threshold" },
  autonomy_halted_on_boot: {
    label: "Autonomy halted on boot",
    hint: "a restart halted trading autonomy until you re-arm it"
  }
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
      <h1 className="px-4 text-[length:var(--con-fs-lg)] font-bold lg:px-0">Settings</h1>

      {/* Account-scoped config (models, tax treatment, prompt, weights) lives on
          Framework (/console/strategy) and Mandates — Settings is global-only. */}

      {/* ── ALL ACCOUNTS ── */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Chip
            tone="accent"
            title="Settings tagged ALL YOUR ACCOUNTS are stored per user — they overlay every account you connect, in every scope."
          >
            ALL YOUR ACCOUNTS
          </Chip>
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            applies everywhere, for you
          </span>
        </div>
        {/* Anchor ids (#brokers/#api-keys) are deep-link targets used by the
            Run-once blocked-reason sheet; scroll-mt clears the sticky chrome. */}
        <div id="brokers" className="scroll-mt-28">
          <BrokerAccountsCard />
        </div>
        <div id="api-keys" className="scroll-mt-28">
          <ApiKeysCard />
        </div>
        {/* notificationSettings is a USER-level policy field (USER_LEVEL_POLICY_FIELDS
            in db-profiles): one event list + webhook overlaid on every account —
            so the card lives under ALL YOUR ACCOUNTS, not THIS ACCOUNT. */}
        <EventNotificationsCard />
        <DeliveryChannelsCard />
        <div id="sharing" className="scroll-mt-28">
          <DataSharingCard />
        </div>
        <ScanShapeCard />
        {/* learningReviewEnabled/Mode/Model are USER-level policy fields
            (USER_LEVEL_POLICY_FIELDS in db-profiles): the review runs once per
            user per day over user-level learned context, so its config overlays
            every account — it belongs under ALL YOUR ACCOUNTS, not THIS ACCOUNT.
            The anchor id is a deep-link target (the Learning Review blocks on
            /console/approvals link here as "Model settings"). */}
        <div id="learning-review" className="scroll-mt-28">
          <LearningReviewCard />
        </div>
        {/* requireTypedConfirmation is a USER-level policy field
            (USER_LEVEL_POLICY_FIELDS in db-profiles, promoted 2026-07-10): the
            phrase ceremony is an owner preference, not a per-account guardrail,
            so one switch applies across every account. */}
        <div id="confirmation" className="scroll-mt-28">
          <AdvancedActionConfirmationCard />
        </div>
        <BootBehaviorCard />
        <YouCard />
      </section>

      {/* ── THIS BROWSER ── */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Chip tone="muted" title="Settings tagged THIS BROWSER are stored in this browser only. They change how the console looks here, not how the strategy trades.">
            THIS BROWSER
          </Chip>
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            local display preferences
          </span>
        </div>
        <AppearanceCard />
      </section>

      {/* ── OPERATOR (admin only: links, no new admin UI) ── */}
      {snapshot.currentUser?.isAdmin && (
        <section id="admin" className="flex scroll-mt-28 flex-col gap-4">
          <div className="flex items-center gap-2">
            <Chip tone="accent" title="Visible because this login has operator/admin rights on the server.">
              OPERATOR
            </Chip>
            <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              server-wide diagnostics, outside the console
            </span>
          </div>
          <AdminLinksCard />
        </section>
      )}

      {/* ── REFERENCE ── */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Chip tone="muted" title="Nothing here changes any setting — it's the app's vocabulary, searchable.">
            REFERENCE
          </Chip>
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            nothing here changes any setting — it&apos;s the app&apos;s vocabulary, searchable
          </span>
        </div>
        <HelpGlossaryCard />
      </section>

      {/* ── DANGER ── */}
      <section id="danger" className="flex scroll-mt-28 flex-col gap-4">
        <div className="flex items-center gap-2">
          <Chip tone="neg" title="Irreversible actions live here, behind typed confirmations — nothing in this section happens by accident.">
            DANGER
          </Chip>
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            irreversible actions, behind typed confirmations
          </span>
        </div>
        <AccountDeletionCard />
      </section>
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
    <Card title="Advanced action confirmation">
      <Field
        label="Type a phrase to confirm high-impact live actions"
        hint="One switch for your whole login — it applies across every account you connect. On: approving a broker order, replacing a live order at market, and loosening a guardrail on a live account each ask you to type a short phrase (e.g. APPROVE LIVE NVDA) first. Off: they are one click. Winding down (which SELLS) and deleting an account always keep their own typed confirmation regardless."
      >
        <div className="flex items-center gap-3">
          <Toggle
            checked={required}
            onChange={(next) => void setRequired(next)}
            disabled={saving}
            label="Require typed confirmation for high-impact live actions"
          />
          <span className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
            {required ? "On — type to confirm" : "Off — one click"}
          </span>
        </div>
      </Field>
    </Card>
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
    <Card title="Appearance">
      <Field label="Console Font" hint="The whole console (nav, cards, copy) uses this font in this browser.">
        <FontOptionGrid options={CONSOLE_FONT_OPTIONS} selected={consoleFont} onSelect={setConsoleFont} />
      </Field>
      <div className="mt-4">
        <Field label="Text Box Font" hint="Editable text boxes use this font in this browser.">
          <FontOptionGrid options={CONSOLE_TEXT_BOX_FONT_OPTIONS} selected={textBoxFont} onSelect={setTextBoxFont} />
        </Field>
      </div>
    </Card>
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
    <Card title="Admin pages">
      <p className="mb-2 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-faint)]">
        Operator diagnostics from the legacy app — they open outside the console and keep their own styling.
      </p>
      <div className="flex flex-col gap-1">
        {ADMIN_LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className="con-row flex items-center justify-between gap-3 rounded-md px-1.5 py-1.5 text-[length:var(--con-fs-sm)]"
            title={`${link.desc} Opens outside the console.`}
          >
            <span>
              <span className="font-semibold">{link.label}</span>
              <span className="ml-2 hidden text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] sm:inline">{link.desc}</span>
            </span>
            <ExternalLink size={13} className="shrink-0 text-[color:var(--con-faint)]" />
          </a>
        ))}
      </div>
    </Card>
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
    <Card title="Event notifications" action={<SaveStatus status={autoSave.status} />}>
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Which events send notifications, and the webhook they go to. One list for your whole login — it applies across
        every account, not just the one you&apos;re viewing. Delivery channels (push/email/SMS) are configured once per
        user, below.
      </p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {NOTIFICATION_EVENT_TYPES.map((type) => {
          const on = events.includes(type);
          const meta = EVENT_META[type];
          return (
            <label
              key={type}
              title={`When on, you get a notification whenever ${meta.hint}.`}
              className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-[length:var(--con-fs-sm)] transition-colors hover:bg-[color:var(--con-surface-2)] focus-within:bg-[color:var(--con-surface-2)]"
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={on}
                disabled={autoSave.saving}
                onChange={() => toggleEvent(type, on)}
              />
              <span className="min-w-0">
                <span className="font-semibold">{meta.label}</span>{" "}
                <span className="text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">{meta.hint}</span>
              </span>
            </label>
          );
        })}
      </div>
      <div className="mt-3 max-w-md">
        <Field label="Webhook URL (optional)" hint="Rich embeds for chat webhooks; generic JSON otherwise." htmlFor="webhook">
          <TextInput
            id="webhook"
            value={webhook}
            placeholder="https://…"
            title="Every enabled event is also POSTed to this URL. Chat webhooks (Discord/Slack) get rich embeds; anything else gets plain JSON. Saves when you click away."
            onChange={(e) => setLocalWebhook(e.target.value)}
            onBlur={commitWebhook}
          />
        </Field>
      </div>
    </Card>
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
    <Card title="Market-scan shape" action={<SaveStatus status={autoSave.status} />}>
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        How wide every account&apos;s market scan looks. These two are user-level, like everything on this page: they
        overlay all your accounts.
      </p>
      <div className="grid max-w-md grid-cols-2 gap-3">
        <Field label="Enriched candidates" hint="Ranked names that get full enrichment per run." htmlFor="scan-limit">
          <RawNumInput
            id="scan-limit"
            value={String(candidateLimit ?? "")}
            emptyValue={0}
            title="How many top-ranked symbols get full enrichment (fundamentals, news, technicals) each run. More = wider view, slower and costlier runs. Saves when you click away."
            onValueChange={(parsed) => setDraft((d) => ({ ...d, marketScanCandidateLimit: parsed }))}
            onBlur={() => commitNumber("marketScanCandidateLimit", candidateLimit, policy.marketScanCandidateLimit)}
          />
        </Field>
        <Field label="Outlier reserve" hint="Below-cutoff slots reserved for notable web signals." htmlFor="scan-reserve">
          <RawNumInput
            id="scan-reserve"
            value={String(outlierReserve ?? "")}
            emptyValue={0}
            title="Of the candidate slots, how many are held for symbols that rank below the cutoff but carry a notable web signal (news spike, unusual activity). Saves when you click away."
            onValueChange={(parsed) => setDraft((d) => ({ ...d, marketScanOutlierReserve: parsed }))}
            onBlur={() => commitNumber("marketScanOutlierReserve", outlierReserve, policy.marketScanOutlierReserve)}
          />
        </Field>
      </div>
    </Card>
  );
}

// ── All accounts: boot behavior ──────────────────────────────────────────────

function BootBehaviorCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!snapshot) return null;

  return (
    <Card title="After a restart">
      <div
        className="flex items-center justify-between gap-4 rounded-md px-1.5 py-1 transition-colors hover:bg-[color:var(--con-surface-2)]"
        title="Controls what happens to Running accounts when the server process restarts. Off keeps the safety net: a human must start trading again."
      >
        <div>
          <div className="text-[length:var(--con-fs-sm)] font-semibold">Auto-resume on boot</div>
          <p className="mt-0.5 max-w-xl text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
            Off (recommended): whenever the server restarts, any Running account is stopped until a person starts it
            again — a restored backup or crash-loop can never silently resume trading. Turning this ON removes that
            safety net.
          </p>
        </div>
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
          label="Auto-resume on boot"
        />
      </div>
    </Card>
  );
}

// ── You ──────────────────────────────────────────────────────────────────────

function YouCard() {
  const { snapshot } = useConsoleData();
  if (!snapshot?.currentUser) return null;
  const user = snapshot.currentUser;
  return (
    <Card title="You">
      <div className="flex flex-wrap items-center gap-2 text-[length:var(--con-fs-sm)]">
        <span className="font-semibold" title="The signed-in user every ALL YOUR ACCOUNTS setting belongs to.">
          {user.name ?? user.email ?? user.userId}
        </span>
        {user.email && user.name && <span className="text-[color:var(--con-faint)]">{user.email}</span>}
        {user.isAdmin && (
          <Chip tone="accent" title="This login has operator/admin rights on the server.">
            admin
          </Chip>
        )}
        {user.loginProvider && (
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]" title="Which identity provider authenticated this session.">
            via {user.loginProvider}
          </span>
        )}
      </div>
    </Card>
  );
}
