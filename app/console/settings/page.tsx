"use client";

/** Settings — scope-split and visibly tagged: what belongs to THIS ACCOUNT
 *  (event notifications, tax treatment) vs ALL YOUR ACCOUNTS (connections,
 *  boot behavior, delivery channels, scan shape). The tag is the perception
 *  device — you never have to remember the storage tier. */

import { useMemo, useState } from "react";
import type { NotificationEventType, TaxationType } from "@/lib/types";
import { NOTIFICATION_EVENT_TYPES } from "@/lib/types";
import {
  activateAccount,
  savePolicy,
  sendTestNotification,
  setAutoResume,
  ConsoleApiError
} from "../lib/api";
import { activeConnectedAccount, deriveReality, realityForAccount } from "../lib/derive";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { Btn, Card, Chip, Field, NumInput, Select, TextInput, Toggle } from "../ui/primitives";

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
  budget_alert: "a usage budget threshold was crossed"
};

export default function SettingsPage() {
  const { snapshot } = useConsoleData();
  const reality = useMemo(() => (snapshot ? deriveReality(snapshot) : null), [snapshot]);
  if (!snapshot || !reality) return null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <h1 className="text-[length:var(--con-fs-lg)] font-bold">Settings</h1>

      {/* ── THIS ACCOUNT ── */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Chip tone={reality.tone}>
            THIS ACCOUNT — {reality.account?.label ?? "Local simulator"} · {reality.word}
          </Chip>
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            changes here follow the account, not you
          </span>
        </div>
        <TaxSettingsCard />
      </section>

      {/* ── ALL ACCOUNTS ── */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Chip tone="accent">ALL YOUR ACCOUNTS</Chip>
          <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            applies everywhere, for you
          </span>
        </div>
        <ConnectionsCard />
        {/* notificationSettings is a USER-level policy field (USER_LEVEL_POLICY_FIELDS
            in db-profiles): one event list + webhook overlaid on every account —
            so the card lives under ALL YOUR ACCOUNTS, not THIS ACCOUNT. */}
        <EventNotificationsCard />
        <DeliveryChannelsCard />
        <ScanShapeCard />
        <BootBehaviorCard />
        <YouCard />
      </section>
    </div>
  );
}

// ── All accounts: event notifications (user-level policy field) ─────────────

function EventNotificationsCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [draftEvents, setDraftEvents] = useState<NotificationEventType[] | null>(null);
  const [draftWebhook, setDraftWebhook] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!snapshot) return null;

  const current = snapshot.policy.notificationSettings;
  const events = draftEvents ?? current.enabledEvents;
  const webhook = draftWebhook ?? current.webhookUrl ?? "";
  const dirty = draftEvents !== null || (draftWebhook !== null && draftWebhook !== (current.webhookUrl ?? ""));

  const save = async () => {
    setBusy(true);
    try {
      await savePolicy({ notificationSettings: { enabledEvents: events, webhookUrl: webhook } });
      await refresh();
      setDraftEvents(null);
      setDraftWebhook(null);
      toast.push("pos", "Event notifications saved");
    } catch (error) {
      toast.push("neg", "Not saved", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Event notifications"
      action={
        dirty ? (
          <div className="flex gap-2">
            <Btn variant="ghost" size="sm" onClick={() => { setDraftEvents(null); setDraftWebhook(null); }}>
              Discard
            </Btn>
            <Btn variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </Btn>
          </div>
        ) : undefined
      }
    >
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Which events send notifications, and the webhook they go to. One list for your whole login — it applies across
        every account, not just the one you&apos;re viewing. Delivery channels (push/email/SMS) are configured once per
        user, below.
      </p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {NOTIFICATION_EVENT_TYPES.map((type) => {
          const on = events.includes(type);
          return (
            <label key={type} className="flex cursor-pointer items-center gap-2 text-[length:var(--con-fs-sm)]">
              <input
                type="checkbox"
                checked={on}
                onChange={() => setDraftEvents(on ? events.filter((e) => e !== type) : [...events, type])}
              />
              <span className="font-semibold">{type}</span>
              <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">{EVENT_HINT[type]}</span>
            </label>
          );
        })}
      </div>
      <div className="mt-3 max-w-md">
        <Field label="Webhook URL (optional)" hint="Rich embeds for chat webhooks; generic JSON otherwise." htmlFor="webhook">
          <TextInput id="webhook" value={webhook} placeholder="https://…" onChange={(e) => setDraftWebhook(e.target.value)} />
        </Field>
      </div>
    </Card>
  );
}

// ── This account: tax settings ───────────────────────────────────────────────

const TAXATION_LABEL: Record<TaxationType, string> = {
  taxable: "taxable brokerage",
  roth_ira: "Roth IRA",
  traditional_ira: "traditional IRA"
};

function TaxSettingsCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [draft, setDraft] = useState<Partial<{
    taxationType: TaxationType;
    washSaleGuard: boolean;
    shortTermRatePct: number;
    longTermRatePct: number;
    subtractFromResults: boolean;
  }> | null>(null);
  const [busy, setBusy] = useState(false);
  if (!snapshot) return null;

  const current = snapshot.policy.taxSettings;
  // The connected account's own taxationType (set when it was linked) WINS over
  // policy.taxSettings server-side (dashboard tax summary reads
  // activeAccount.taxationType ?? policy.taxSettings.taxationType), and no API
  // exists to edit it here — so when the account defines it, show it read-only
  // instead of a select whose "saved" value would be silently overridden.
  const accountTaxationType = activeConnectedAccount(snapshot)?.taxationType;
  const taxation: TaxationType = accountTaxationType ?? draft?.taxationType ?? current?.taxationType ?? "taxable";
  const washSaleGuard: boolean = draft?.washSaleGuard ?? current?.washSaleGuard ?? true;
  const subtractFromResults: boolean = draft?.subtractFromResults ?? current?.subtractFromResults ?? false;
  const shortTermRatePct: number = draft?.shortTermRatePct ?? current?.shortTermRatePct ?? 24;
  const longTermRatePct: number = draft?.longTermRatePct ?? current?.longTermRatePct ?? 15;

  const save = async () => {
    setBusy(true);
    try {
      await savePolicy({ taxSettings: draft ?? {} });
      await refresh();
      setDraft(null);
      toast.push("pos", "Tax settings saved");
    } catch (error) {
      toast.push("neg", "Not saved", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Tax treatment"
      action={
        draft ? (
          <div className="flex gap-2">
            <Btn variant="ghost" size="sm" onClick={() => setDraft(null)}>
              Discard
            </Btn>
            <Btn variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </Btn>
          </div>
        ) : undefined
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {accountTaxationType ? (
          <Field
            label="Account type"
            hint="Set on the connected account when it was linked — that value always wins over anything saved here, and this console can't change it yet."
          >
            <div className="con-input flex items-center bg-[color:var(--con-surface-2)] text-[color:var(--con-muted)]">
              {TAXATION_LABEL[accountTaxationType] ?? accountTaxationType}
            </div>
          </Field>
        ) : (
          <Field label="Account type" hint="IRAs zero the rates and skip the per-account wash-sale guard automatically." htmlFor="taxtype">
            <Select
              id="taxtype"
              value={taxation}
              onChange={(e) => setDraft((d) => ({ ...(d ?? {}), taxationType: e.target.value as TaxationType }))}
            >
              <option value="taxable">taxable brokerage</option>
              <option value="roth_ira">Roth IRA</option>
              <option value="traditional_ira">traditional IRA</option>
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Short-term rate %" htmlFor="st-rate">
            <NumInput
              id="st-rate"
              value={String(shortTermRatePct)}
              onChange={(e) => setDraft((d) => ({ ...(d ?? {}), shortTermRatePct: Number(e.target.value) }))}
            />
          </Field>
          <Field label="Long-term rate %" htmlFor="lt-rate">
            <NumInput
              id="lt-rate"
              value={String(longTermRatePct)}
              onChange={(e) => setDraft((d) => ({ ...(d ?? {}), longTermRatePct: Number(e.target.value) }))}
            />
          </Field>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[length:var(--con-fs-sm)] font-semibold">Wash-sale guard</div>
            <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              Blocks rebuying a symbol closed at a loss within 30 days. A loss in any taxable account locks the symbol
              across ALL your accounts, including IRAs.
            </p>
          </div>
          <Toggle
            checked={washSaleGuard}
            onChange={(next) => setDraft((d) => ({ ...(d ?? {}), washSaleGuard: next }))}
            label="Wash-sale guard"
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[length:var(--con-fs-sm)] font-semibold">Show results net of estimated tax</div>
            <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">Estimates only — not tax advice.</p>
          </div>
          <Toggle
            checked={subtractFromResults}
            onChange={(next) => setDraft((d) => ({ ...(d ?? {}), subtractFromResults: next }))}
            label="Subtract tax from results"
          />
        </div>
      </div>
    </Card>
  );
}

// ── All accounts: connections ────────────────────────────────────────────────

function ConnectionsCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  if (!snapshot) return null;

  return (
    <Card title="Connected accounts">
      {snapshot.connectedAccounts.length === 0 ? (
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          No brokerage connected — everything runs in the local simulator (TEST · practice money). You can stay here
          forever; connecting a broker is never required. Adding a new connection isn&apos;t available in this console yet.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {snapshot.connectedAccounts.map((account) => {
            const r = realityForAccount(account);
            const caps = account.capabilities;
            return (
              <div key={account.id} className="rounded-lg border border-[color:var(--con-line)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-semibold">{account.label || account.broker}</span>
                    <Chip tone={r.tone}>
                      {r.word} · {r.phrase}
                    </Chip>
                    {account.isActive && <Chip tone="accent">active</Chip>}
                  </div>
                  {!account.isActive && (
                    <Btn
                      size="sm"
                      variant={r.tone === "live" ? "dangerOutline" : "outline"}
                      disabled={busyId !== null}
                      onClick={async () => {
                        setBusyId(account.id);
                        try {
                          await activateAccount(account.id);
                          await refresh();
                          toast.push("info", "Active account switched");
                        } catch (error) {
                          toast.push("neg", "Could not switch", error instanceof ConsoleApiError ? error.message : String(error));
                        } finally {
                          setBusyId(null);
                        }
                      }}
                    >
                      {busyId === account.id ? "Switching…" : "Make active"}
                    </Btn>
                  )}
                </div>
                <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                  {account.broker} · {account.environment}
                  {account.accountNumber ? ` · ·· ${account.accountNumber.slice(-4)}` : ""}
                  {caps
                    ? ` — broker allows: stocks ${caps.equityTrading ? "yes" : "no"} · shorting ${caps.shortSelling ? "yes" : "no"} · options ${caps.optionsTrading ? `level ${caps.optionsLevel ?? "?"}` : "no"} · margin ${caps.marginEnabled ? "yes" : "no"}`
                    : " — capabilities not confirmed by the broker yet: everything reads as off"}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ── All accounts: delivery channels ──────────────────────────────────────────

function DeliveryChannelsCard() {
  const { snapshot } = useConsoleData();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!snapshot) return null;

  const status = snapshot.notificationStatus;

  return (
    <Card
      title="Delivery channels"
      action={
        <Btn
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const { results } = await sendTestNotification();
              const ok = results.filter((r) => r.ok).length;
              const skipped = results.filter((r) => r.skipped).length;
              toast.push(
                ok > 0 ? "pos" : "warn",
                `Test sent — ${ok} delivered`,
                results
                  .map((r) => `${r.channel}: ${r.ok ? "ok" : r.skipped ?? r.error ?? "failed"}`)
                  .join(" · ") + (ok === 0 && skipped === results.length ? " — no channel is configured yet" : "")
              );
            } catch (error) {
              toast.push("neg", "Test failed", error instanceof ConsoleApiError ? error.message : String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Sending…" : "Send test"}
        </Btn>
      }
    >
      <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
        {status.configured
          ? "At least one out-of-app channel is configured. Use the test to confirm your phone actually hears an alert before trusting real-money notifications."
          : "No out-of-app channel is configured yet — events are only recorded in Activity. Channel targets (push topic, email, phone, webhook) are managed by the server's notification preferences."}
      </p>
      {status.enabledEvents.length > 0 && (
        <p className="mt-2 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Events currently enabled for you (all accounts): {status.enabledEvents.join(", ")}
        </p>
      )}
    </Card>
  );
}

// ── All accounts: scan shape ─────────────────────────────────────────────────

function ScanShapeCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [draft, setDraft] = useState<{ marketScanCandidateLimit?: number; marketScanOutlierReserve?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!snapshot) return null;

  const policy = snapshot.policy;

  const save = async () => {
    setBusy(true);
    try {
      await savePolicy(draft ?? {});
      await refresh();
      setDraft(null);
      toast.push("pos", "Scan shape saved", "Applies to every account's runs.");
    } catch (error) {
      toast.push("neg", "Not saved", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Market-scan shape"
      action={
        draft ? (
          <div className="flex gap-2">
            <Btn variant="ghost" size="sm" onClick={() => setDraft(null)}>
              Discard
            </Btn>
            <Btn variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </Btn>
          </div>
        ) : undefined
      }
    >
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        How wide every account&apos;s market scan looks. These two are user-level: they overlay all your accounts — the
        one deliberate exception to account scoping, labeled rather than hidden.
      </p>
      <div className="grid max-w-md grid-cols-2 gap-3">
        <Field label="Enriched candidates" hint="Ranked names that get full enrichment per run." htmlFor="scan-limit">
          <NumInput
            id="scan-limit"
            value={String(draft?.marketScanCandidateLimit ?? policy.marketScanCandidateLimit ?? "")}
            onChange={(e) => setDraft((d) => ({ ...(d ?? {}), marketScanCandidateLimit: Number(e.target.value) }))}
          />
        </Field>
        <Field label="Outlier reserve" hint="Below-cutoff slots reserved for notable web signals." htmlFor="scan-reserve">
          <NumInput
            id="scan-reserve"
            value={String(draft?.marketScanOutlierReserve ?? policy.marketScanOutlierReserve ?? "")}
            onChange={(e) => setDraft((d) => ({ ...(d ?? {}), marketScanOutlierReserve: Number(e.target.value) }))}
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
      <div className="flex items-center justify-between gap-4">
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
        <span className="font-semibold">{user.name ?? user.email ?? user.userId}</span>
        {user.email && user.name && <span className="text-[color:var(--con-faint)]">{user.email}</span>}
        {user.isAdmin && <Chip tone="accent">admin</Chip>}
        {user.loginProvider && <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">via {user.loginProvider}</span>}
      </div>
    </Card>
  );
}
