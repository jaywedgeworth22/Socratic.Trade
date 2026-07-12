"use client";

/** Delivery channels — where out-of-app alerts actually go (phone push,
 *  webhook, email, SMS). Reads GET /api/notifications (channel availability +
 *  saved prefs), writes POST /api/notifications, and exercises every enabled
 *  channel via the existing test endpoint. A channel can only be enabled when
 *  the server operator has configured its provider (e.g. email needs a Resend
 *  key) — unavailable ones say so instead of failing silently.
 *
 *  Auto-saves like every other settings card (owner-directed 2026-07-09):
 *  channel toggles save on change, each channel's target field saves on
 *  blur. saveDeliveryPrefs is a whole-object POST, so every write sends the
 *  full merged prefs (saved ∪ any other in-progress local edits) — never
 *  just the one changed field — so a toggle never drops a pending target
 *  edit in a sibling field, and vice versa. */

import { useCallback, useEffect, useState } from "react";
import { sendTestNotification, ConsoleApiError } from "../lib/api";
import { useAutoSave } from "../lib/useAutoSave";
import { useToast } from "../ui/toast";
import { SaveStatus } from "../ui/save-status";
import { Btn, Card, Field, TextInput, Toggle } from "../ui/primitives";
import { ListSection, ListRow, LabeledContent } from "../../ui/ios-components";
import {
  fetchDeliverySettings,
  saveDeliveryPrefs,
  EMPTY_DELIVERY_PREFS,
  type DeliveryChannelDescriptor,
  type DeliveryPrefs
} from "./lib";

const CHANNEL_TITLE: Record<DeliveryChannelDescriptor["id"], string> = {
  push: "A push notification on your phone via a notification app — usually the fastest and cheapest channel.",
  webhook: "An HTTPS POST with a JSON payload to any URL you control (chat webhooks get rich embeds).",
  email: "An email per alert. Needs the server operator to have configured an email provider.",
  sms: "A text message per alert. Needs the server operator's Twilio credentials; carrier rates may apply."
};

type TargetField = "pushTarget" | "webhookUrl" | "email" | "phone";

interface TestResult {
  channel: string;
  ok: boolean;
  skipped?: string;
  error?: string;
}

export function DeliveryChannelsCard() {
  const toast = useToast();
  const autoSave = useAutoSave();
  const [channels, setChannels] = useState<DeliveryChannelDescriptor[] | null>(null);
  const [saved, setSaved] = useState<DeliveryPrefs>(EMPTY_DELIVERY_PREFS);
  // Sticky optimistic overlay: seeded from the loaded snapshot, updated
  // immediately on toggle/blur for instant feedback, reverted per-field by
  // useAutoSave's onError if a write fails.
  const [local, setLocal] = useState<DeliveryPrefs | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [results, setResults] = useState<TestResult[] | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await fetchDeliverySettings();
      setChannels(body.channels ?? []);
      const prefs = { ...EMPTY_DELIVERY_PREFS, ...body.prefs, channels: body.prefs?.channels ?? [] };
      setSaved(prefs);
      setLocal(prefs);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof ConsoleApiError ? error.message : "Could not load delivery channels.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const prefs = local ?? saved;
  const busy = autoSave.saving || testBusy;

  // Persist the full merged prefs object (whole-object POST) and adopt the
  // server's response as the new saved/local baseline.
  const persist = (next: DeliveryPrefs, opts: { onError: () => void; successToast?: { title: string; detail?: string } }) => {
    autoSave.save(
      async () => {
        const { prefs: persisted } = await saveDeliveryPrefs(next);
        const merged = { ...EMPTY_DELIVERY_PREFS, ...persisted, channels: persisted?.channels ?? [] };
        setSaved(merged);
        setLocal(merged);
      },
      opts
    );
  };

  const toggleChannel = (id: string, on: boolean) => {
    const prevChannels = prefs.channels;
    const nextChannels = on ? Array.from(new Set([...prefs.channels, id])) : prefs.channels.filter((c) => c !== id);
    const next = { ...prefs, channels: nextChannels };
    setLocal(next);
    const label = channels?.find((c) => c.id === id)?.label ?? id;
    persist(next, {
      onError: () => setLocal((l) => (l ? { ...l, channels: prevChannels } : l)),
      successToast: { title: `${label} delivery ${on ? "on" : "off"}` }
    });
  };

  const targetValue = (field: TargetField) => prefs[field];
  const setTarget = (field: TargetField, value: string) => setLocal((l) => ({ ...(l ?? prefs), [field]: value }));

  const commitTarget = (field: TargetField) => {
    const raw = targetValue(field);
    const trimmed = raw.trim();
    const savedValue = saved[field];
    if (trimmed === savedValue) {
      // No real change (or just whitespace trimmed) — no write, but normalize
      // the visible value.
      if (trimmed !== raw) setLocal((l) => (l ? { ...l, [field]: trimmed } : l));
      return;
    }
    const next = { ...prefs, [field]: trimmed };
    setLocal(next);
    persist(next, {
      onError: () => setLocal((l) => (l ? { ...l, [field]: savedValue } : l))
    });
  };

  const sendTest = async () => {
    setTestBusy(true);
    setResults(null);
    try {
      // Fires against whatever's already saved on the server — channels now
      // auto-save on toggle and targets on blur, so there's nothing to
      // persist first.
      const { results: r } = await sendTestNotification();
      setResults(r);
      const sent = r.filter((x) => x.ok).length;
      if (sent > 0) toast.push("pos", `Test sent via ${sent} channel${sent > 1 ? "s" : ""}`, "Check that it actually arrived before trusting real-money alerts.");
      else toast.push("warn", "No channel delivered", "Check the toggles, targets, and the server's provider keys.");
    } catch (error) {
      toast.push("neg", "Test failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setTestBusy(false);
    }
  };

  return (
    <ListSection
      title="Delivery channels"
      action={
        <div className="flex items-center gap-3">
          <SaveStatus status={autoSave.status} />
          <Btn
            size="sm"
            disabled={busy || channels === null}
            onClick={() => void sendTest()}
            title="Fires a test alert through every enabled, saved channel so you can confirm it reaches you."
          >
            {testBusy ? "Sending…" : "Send test"}
          </Btn>
        </div>
      }
    >
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)] px-2">
        Where alerts leave the app — one setup for your whole login, across every account. Which events fire is chosen
        in Event notifications above; this is how they reach you. Without any channel, events are still recorded in
        Activity, just not pushed anywhere.
      </p>

      {loadError && (
        <div className="px-2 mb-3">
          <p className="rounded-lg border border-[color:var(--con-warn-border)] bg-[color:var(--con-warn-soft)] p-2.5 text-[length:var(--con-fs-xs)]">
            {loadError}{" "}
            <button type="button" className="font-semibold underline" onClick={() => void load()} title="Try loading the channels again.">
              Retry
            </button>
          </p>
        </div>
      )}

      {channels === null && !loadError && (
        <ListRow>
          <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)] py-1">Loading channels…</p>
        </ListRow>
      )}

      {channels !== null && channels.map((ch) => {
        const on = prefs.channels.includes(ch.id);
        const target = targetValue(ch.targetField as TargetField);
        return (
          <ListRow key={ch.id}>
            <div className="flex flex-col gap-2 w-full">
              <LabeledContent label={
                <div className="flex flex-wrap items-center gap-2">
                  <span title={CHANNEL_TITLE[ch.id]}>{ch.label}</span>
                  {ch.id === "push" && ch.available && (
                    <span
                      className="rounded-full border border-[color:var(--con-pos-border)] bg-[color:var(--con-pos-soft)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[color:var(--con-pos)]"
                      title="Push via ntfy needs no account or key and is free — the recommended first channel."
                    >
                      recommended · free
                    </span>
                  )}
                  {!ch.available && (
                    <span
                      className="text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)] font-normal"
                      title="The server operator hasn't configured this channel's provider, so it can't be enabled from here."
                    >
                      not configured on the server
                    </span>
                  )}
                </div>
              } hint={ch.id === "push" && ch.available ? undefined : ""}>
                <Toggle
                  checked={on}
                  disabled={!ch.available || busy}
                  onChange={(next) => toggleChannel(ch.id, next)}
                />
              </LabeledContent>
              
              {on && ch.available && (
                <div className="pl-2 pr-1 pb-1 mt-1 border-t border-[color:var(--con-border-subtle)] pt-2">
                  <LabeledContent label={ch.targetLabel} hint={ch.hint}>
                    <input
                      id={`ch-${ch.id}`}
                      className="w-48 text-right bg-transparent text-[length:var(--con-fs-sm)] focus:outline-none placeholder:text-[color:var(--con-muted)]"
                      value={typeof target === "string" ? target : ""}
                      placeholder={ch.placeholder}
                      onChange={(e) => setTarget(ch.targetField as TargetField, e.target.value)}
                      onBlur={() => commitTarget(ch.targetField as TargetField)}
                      title={ch.hint}
                    />
                  </LabeledContent>
                </div>
              )}
            </div>
          </ListRow>
        );
      })}

      {results && (
        <ListRow>
          <ul className="flex flex-col gap-1 text-[length:var(--con-fs-xs)] w-full py-2">
            {results.length === 0 && <li className="text-[color:var(--con-muted)]">No channels enabled — toggle one above first.</li>}
            {results.map((r, i) => (
              <li
                key={i}
                className={r.ok ? "text-[color:var(--con-pos)]" : "text-[color:var(--con-muted)]"}
                title={r.ok ? "The test message was accepted by the provider." : r.skipped ? "Skipped — the channel is off, has no target, or its provider isn't configured." : r.error ?? "The provider rejected the test."}
              >
                {r.ok ? "✓" : "—"} {r.channel}
                {r.skipped ? ` (${r.skipped.replace(/_/g, " ")})` : r.ok ? " — sent" : ` — failed${r.error ? `: ${r.error}` : ""}`}
              </li>
            ))}
          </ul>
        </ListRow>
      )}
    </ListSection>
  );
}
