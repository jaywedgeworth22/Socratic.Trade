"use client";

/** Broker connections — connect (Robinhood OAuth, Alpaca keys), inspect,
 *  activate, and disconnect brokerage accounts. Every row states its
 *  money-reality in words; disconnecting always asks first and says exactly
 *  what it does (removes the connection from this app — never touches the
 *  broker). Improves on the legacy IntegrationsSection: same endpoints,
 *  console visual grammar, honest copy, tooltips on everything. */

import { useCallback, useEffect, useState } from "react";
import type { ConnectedAccount, TaxationType } from "@/lib/types";
import { activateAccount, ConsoleApiError } from "../lib/api";
import { realityForAccount } from "../lib/derive";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { Sheet } from "../ui/sheet";
import { Btn, Card, Chip, Field, LiveTag, Select, TextInput } from "../ui/primitives";
import { Briefcase, ArrowDown, Zap, Scale, AlertTriangle } from "lucide-react";
import {
  connectAlpacaAccount,
  connectTestAccount,
  disconnectAccount,
  fetchRobinhoodHealth,
  syncRobinhoodAccount,
  ROBINHOOD_OAUTH_START_URL,
  type RobinhoodMcpHealth
} from "./lib";

function brokerName(broker: ConnectedAccount["broker"]): string {
  switch (broker) {
    case "alpaca":
      return "Alpaca";
    case "alpaca-mcp":
      return "Alpaca MCP";
    case "robinhood":
      return "Robinhood";
    case "test":
      return "Test Account";
    default:
      return broker;
  }
}

const TAXATION_WORD: Record<TaxationType, string> = {
  taxable: "taxable",
  roth_ira: "Roth IRA",
  traditional_ira: "traditional IRA"
};

const BROKER_ROADMAP = [
  {
    name: "Public.com",
    status: "Needs API approval",
    detail:
      "Public.com is listed here so the intended broker set is visible, but this app does not have a Public.com trading gateway yet."
  },
  {
    name: "eToro",
    status: "Partner/API gated",
    detail:
      "eToro support needs an approved API path before account sync or order placement can be implemented safely."
  },
  {
    name: "IBKR",
    status: "Gateway required",
    detail:
      "Interactive Brokers needs an IB Gateway or TWS session plus a dedicated broker adapter before it can be connected here."
  }
] as const;

export function BrokerAccountsCard() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [rhHealth, setRhHealth] = useState<RobinhoodMcpHealth | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ConnectedAccount | null>(null);
  const [alpacaOpen, setAlpacaOpen] = useState(false);

  // Best-effort Robinhood OAuth health — decides whether "Connect Robinhood"
  // starts OAuth or just re-syncs, and flags rows that need a reconnect.
  const loadRhHealth = useCallback(async () => {
    try {
      setRhHealth(await fetchRobinhoodHealth());
    } catch {
      // Health endpoint itself failing = treat as not connected; rows fall
      // back to neutral copy rather than a false "connected".
      setRhHealth(null);
    }
  }, []);

  useEffect(() => {
    void loadRhHealth();
  }, [loadRhHealth]);

  const syncRobinhood = useCallback(async () => {
    setBusy("robinhood");
    try {
      const result = await syncRobinhoodAccount();
      await refresh();
      toast.push("pos", "Robinhood account synced", result.label ? `Linked "${result.label}".` : undefined);
    } catch (error) {
      toast.push("neg", "Robinhood sync failed", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [refresh, toast]);

  // If the OAuth flow ever returns to this page (?robinhoodMcp=connected),
  // finish the job: pull the agentic account into connected accounts.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("robinhoodMcp") !== "connected") return;
    params.delete("robinhoodMcp");
    const qs = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
    void syncRobinhood().then(() => loadRhHealth());
  }, [syncRobinhood, loadRhHealth]);

  if (!snapshot) return null;

  const accounts = snapshot.connectedAccounts;
  const rhAuthed = Boolean(rhHealth?.configured && rhHealth?.authenticated && rhHealth?.ok);
  const rhNeedsReconnect = (account: ConnectedAccount) =>
    account.broker === "robinhood" && rhHealth !== null && !rhAuthed;
  const hasTestAccount = accounts.some((account) => account.broker === "test");
  // Exactly one account carries isActive — hoist it as the "Currently Loaded"
  // account; everything else lists under "Other Accounts". Same isActive flag,
  // no server/query change.
  const loaded = accounts.find((account) => account.isActive);
  const others = accounts.filter((account) => !account.isActive);

  const connectRobinhood = () => {
    if (rhAuthed) {
      void syncRobinhood();
    } else {
      // Full-page redirect into the broker's OAuth. It returns via the app's
      // callback, which lands on the dashboard and completes the sync there.
      window.location.href = ROBINHOOD_OAUTH_START_URL;
    }
  };

  const remove = async (account: ConnectedAccount) => {
    setBusy(account.id);
    try {
      await disconnectAccount(account.id);
      await refresh();
      setConfirmRemove(null);
      toast.push("pos", "Connection removed", `${account.label || brokerName(account.broker)} was disconnected from this app. Nothing changed at the broker.`);
    } catch (error) {
      toast.push("neg", "Could not disconnect", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const connectTest = async () => {
    setBusy("test");
    try {
      const result = await connectTestAccount();
      await refresh();
      toast.push(
        "pos",
        result.label ? `${result.label} added` : "Test Account added",
        "Not loaded automatically. Load it to practice; it cannot reach real money."
      );
    } catch (error) {
      toast.push("neg", "Could not add test account", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  // One row renderer, reused for the loaded account and each "Other" account so
  // the two sections stay identical in look and behavior.
  const renderAccountRow = (account: ConnectedAccount) => {
    const r = realityForAccount(account);
    const caps = account.capabilities;
    const needsReconnect = rhNeedsReconnect(account);
    return (
      <div
        key={account.id}
        tabIndex={0}
        className="rounded-lg border border-[color:var(--con-line)] p-3 transition-colors hover:bg-[color:var(--con-surface-2)] focus-visible:bg-[color:var(--con-surface-2)]"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-semibold" title={`${brokerName(account.broker)} connection${account.accountNumber ? ` · account ${account.accountNumber}` : ""}`}>
              {account.label || brokerName(account.broker)}
            </span>
            <Chip tone={r.tone} title={r.clarification}>
              {r.word} · {r.phrase}
            </Chip>
            {needsReconnect && (
              <Chip tone="warn" title="The Robinhood OAuth session is missing or expired, so this app can't reach the broker for this account until you reconnect.">
                reconnect needed
              </Chip>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {needsReconnect && (
              <Btn
                size="sm"
                variant="primary"
                disabled={busy !== null}
                onClick={() => {
                  window.location.href = ROBINHOOD_OAUTH_START_URL;
                }}
                title="Re-run Robinhood's OAuth sign-in to restore this connection."
              >
                Reconnect
              </Btn>
            )}
            {!account.isActive && (
              <Btn
                size="sm"
                variant="outline"
                disabled={busy !== null}
                title="Load this account — the whole console rescopes to it."
                onClick={async () => {
                  setBusy(account.id);
                  try {
                    await activateAccount(account.id);
                    await refresh();
                    toast.push("info", "Account loaded", `Switched to ${account.label || brokerName(account.broker)}.`);
                  } catch (error) {
                    toast.push("neg", "Could not load", error instanceof ConsoleApiError ? error.message : String(error));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === account.id ? "Loading…" : r.tone === "live" ? (
                  <>
                    Load <LiveTag />
                  </>
                ) : (
                  "Load"
                )}
              </Btn>
            )}
            <Btn
              size="sm"
              variant="dangerOutline"
              disabled={busy !== null}
              onClick={() => setConfirmRemove(account)}
              title="Remove this connection (and its stored credentials) from this app. The broker account itself is untouched — open positions and resting orders stay at the broker."
            >
              Disconnect
            </Btn>
          </div>
        </div>
        <p
          className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
          title="Broker, environment, account tail, and tax treatment."
        >
          {`${brokerName(account.broker)} · ${account.environment}`}
          {account.accountNumber ? ` · ·· ${account.accountNumber.slice(-4)}` : ""}
          {account.taxationType ? ` · ${TAXATION_WORD[account.taxationType] ?? account.taxationType}` : ""}
          {account.broker === "test" && " — excluded from wash-sale accounting"}
        </p>
        {account.broker !== "test" && (
          <div className="mt-2 flex flex-wrap gap-2">
            {caps ? (
              <>
                <Chip
                  tone="info"
                  title={`Stocks trading: ${caps.equityTrading ? "enabled" : "disabled"}`}
                >
                  <Briefcase className="inline size-3.5 mr-1.5" />
                  stocks
                </Chip>
                <Chip
                  tone="info"
                  title={`Short selling: ${caps.shortSelling ? "enabled" : "disabled"}`}
                >
                  <ArrowDown className="inline size-3.5 mr-1.5" />
                  shorting
                </Chip>
                {caps.optionsTrading && (
                  <Chip
                    tone="info"
                    title={`Options trading at level ${caps.optionsLevel ?? "?"}`}
                  >
                    <Zap className="inline size-3.5 mr-1.5" />
                    options L{caps.optionsLevel}
                  </Chip>
                )}
                {caps.marginEnabled && (
                  <Chip
                    tone="info"
                    title="Margin trading enabled"
                  >
                    <Scale className="inline size-3.5 mr-1.5" />
                    margin
                  </Chip>
                )}
              </>
            ) : (
              <Chip
                tone="warn"
                title="Broker has not yet confirmed this account's trading capabilities. All capabilities read as off until confirmed."
              >
                <AlertTriangle className="inline size-3.5 mr-1.5" />
                capabilities unconfirmed
              </Chip>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <Card
      title="Broker connections"
      action={
        <div className="flex gap-2">
          <Btn
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={connectRobinhood}
            title={
              rhAuthed
                ? "Robinhood OAuth is already connected — this re-syncs the agentic account details from the broker."
                : "Opens Robinhood's own sign-in (OAuth). This app never sees your Robinhood password."
            }
          >
            {busy === "robinhood" ? "Syncing…" : rhAuthed ? "Sync Robinhood" : "Connect Robinhood"}
          </Btn>
          <Btn
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => setAlpacaOpen(true)}
            title="Link an Alpaca account with its API key pair. Paper vs live is inferred from the credentials."
          >
            Connect Alpaca
          </Btn>
          <Btn
            size="sm"
            variant="outline"
            disabled={busy !== null || hasTestAccount}
            onClick={() => void connectTest()}
            title={
              hasTestAccount
                ? "A Test Account already exists. It is only used if you load it."
                : "Add a Test Account for practice trades. Not loaded automatically; cannot reach real money."
            }
          >
            {busy === "test" ? "Adding..." : hasTestAccount ? "Test Account Added" : "Add Test Account"}
          </Btn>
        </div>
      }
    >
      <p className="mb-3 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        Connections apply to your whole login. Exactly one account is loaded at a time; the whole console is scoped to
        that account, including its authority, strategy, and decision history.
      </p>

      {accounts.length === 0 ? (
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
          No brokerage connected yet. Use the buttons above when you want broker-backed execution — Robinhood connects
          through the broker&apos;s own sign-in, Alpaca through an API key pair.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <section>
            <h3 className="mb-2 text-[length:var(--con-fs-sm)] font-semibold">Currently Loaded Account</h3>
            {loaded ? (
              renderAccountRow(loaded)
            ) : (
              <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                No account loaded — select one below.
              </p>
            )}
          </section>
          <section>
            <h3 className="mb-2 text-[length:var(--con-fs-sm)] font-semibold">Other Accounts</h3>
            {others.length > 0 ? (
              <div className="flex flex-col gap-2">{others.map(renderAccountRow)}</div>
            ) : (
              <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                No other accounts. Use the buttons above to connect one.
              </p>
            )}
          </section>
        </div>
      )}

      <div className="mt-4 border-t border-[color:var(--con-line)] pt-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-[length:var(--con-fs-sm)] font-semibold">Broker roadmap</h3>
          <Chip tone="muted" title="Visible planning list only. These buttons stay disabled until real broker gateways exist.">
            not wired yet
          </Chip>
        </div>
        <div className="grid gap-2 lg:grid-cols-3">
          {BROKER_ROADMAP.map((broker) => (
            <div
              key={broker.name}
              className="rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] p-3"
              title={broker.detail}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold">{broker.name}</span>
                <Chip tone="warn">{broker.status}</Chip>
              </div>
              <p className="mt-2 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]">
                {broker.detail}
              </p>
              <Btn
                size="sm"
                variant="ghost"
                disabled
                className="mt-2"
                title={`Connect ${broker.name} is disabled because no ${broker.name} broker gateway exists in this app yet.`}
              >
                Connect unavailable
              </Btn>
            </div>
          ))}
        </div>
      </div>

      {/* Disconnect confirm — explicit about what is and is not affected. */}
      <Sheet
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        title={`Disconnect ${confirmRemove?.label || (confirmRemove ? brokerName(confirmRemove.broker) : "")}?`}
        tone={confirmRemove && realityForAccount(confirmRemove).tone === "live" ? "live" : undefined}
      >
        {confirmRemove && (
          <div className="flex flex-col gap-3 text-[length:var(--con-fs-sm)]">
            <p>
              This removes the connection and its stored credentials from this app.{" "}
              <span className="font-semibold">Nothing changes at the broker</span> — open positions and resting orders
              stay exactly where they are; this app just stops seeing and managing them.
            </p>
            {realityForAccount(confirmRemove).tone === "live" && (
              <p className="rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] p-2.5 text-[length:var(--con-fs-xs)]">
                This is a brokerage connection. After disconnecting, any app-managed stop rules for its
                positions stop running — only broker-held orders keep protecting them.
              </p>
            )}
            {confirmRemove.isActive && (
              <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-warn)]">
                This is the currently loaded account. Disconnecting it rescopes the console to the next loaded account,
                if one remains.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Btn variant="ghost" onClick={() => setConfirmRemove(null)} title="Keep the connection.">
                Cancel
              </Btn>
              <Btn
                variant="danger"
                disabled={busy !== null}
                onClick={() => void remove(confirmRemove)}
                title="Remove the connection from this app now."
              >
                {busy === confirmRemove.id ? "Disconnecting…" : "Disconnect"}
              </Btn>
            </div>
          </div>
        )}
      </Sheet>

      <AlpacaConnectSheet
        open={alpacaOpen}
        onClose={() => setAlpacaOpen(false)}
        onConnected={async () => {
          setAlpacaOpen(false);
          await refresh();
        }}
      />
    </Card>
  );
}

// ── Alpaca connect (API key pair) ────────────────────────────────────────────

function AlpacaConnectSheet({
  open,
  onClose,
  onConnected
}: {
  open: boolean;
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [taxationType, setTaxationType] = useState<"" | TaxationType>("");
  const [busy, setBusy] = useState(false);

  const inferredPaper = accountNumber.trim().toUpperCase().startsWith("PA") || apiKey.trim().toUpperCase().startsWith("PK");

  const submit = async () => {
    if (!accountNumber.trim()) {
      toast.push("warn", "Account number is required");
      return;
    }
    if (!apiKey.trim()) {
      toast.push("warn", "API key is required");
      return;
    }
    setBusy(true);
    try {
      await connectAlpacaAccount({
        label: label.trim() || undefined,
        accountNumber: accountNumber.trim(),
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim() || undefined,
        taxationType: taxationType || undefined
      });
      toast.push("pos", "Alpaca account connected", inferredPaper ? "Connected as Alpaca PAPER Account (NOT Real Money)." : "Connected as a brokerage account.");
      setLabel("");
      setAccountNumber("");
      setApiKey("");
      setApiSecret("");
      setTaxationType("");
      await onConnected();
    } catch (error) {
      toast.push("neg", "Could not connect", error instanceof ConsoleApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Connect Alpaca">
      <div className="flex flex-col gap-3">
        <p className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Paste the API key pair from your Alpaca dashboard. Paper accounts are inferred from the credentials
          (&quot;PA…&quot; account numbers and &quot;PK…&quot; keys are paper) — currently reading as{" "}
          <span className={inferredPaper ? "font-bold text-[color:var(--con-paper)]" : "font-bold text-[color:var(--con-accent)]"}>
            {inferredPaper ? "Alpaca PAPER Account (NOT Real Money)" : "Brokerage Account"}
          </span>
          . Credentials are stored server-side and never shown again.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Label (optional)" hint="A name you'll recognize in the account switcher." htmlFor="alp-label">
            <TextInput
              id="alp-label"
              value={label}
              placeholder="Paper, Roth IRA, etc"
              onChange={(e) => setLabel(e.target.value)}
              title="Display name for this connection inside the app."
            />
          </Field>
          <Field label="Account number" hint={'"PA…" means a paper account.'} htmlFor="alp-acct">
            <TextInput
              id="alp-acct"
              value={accountNumber}
              placeholder="e.g. PA12345"
              onChange={(e) => setAccountNumber(e.target.value)}
              title="Your Alpaca account number. Determines paper vs live together with the key."
            />
          </Field>
          <Field label="API key" hint='"PK…" keys are paper keys.' htmlFor="alp-key">
            <TextInput
              id="alp-key"
              value={apiKey}
              autoComplete="off"
              placeholder="API key or OAuth token"
              onChange={(e) => setApiKey(e.target.value)}
              title="The API key ID from Alpaca. Sent once to the server, never echoed back."
            />
          </Field>
          <Field label="API secret" hint="Required for key pairs; omit for OAuth tokens." htmlFor="alp-secret">
            <TextInput
              id="alp-secret"
              type="password"
              value={apiSecret}
              autoComplete="off"
              placeholder="Secret key"
              onChange={(e) => setApiSecret(e.target.value)}
              title="The matching secret key. Stored server-side only."
            />
          </Field>
          <Field
            label="Tax treatment (optional)"
            hint="IRAs zero the estimated tax rates and skip the per-account wash-sale guard."
            htmlFor="alp-tax"
          >
            <Select
              id="alp-tax"
              value={taxationType}
              onChange={(e) => setTaxationType(e.target.value as "" | TaxationType)}
              title="How gains in this account are taxed — drives the tax estimates and wash-sale handling."
            >
              <option value="">not set</option>
              <option value="taxable">taxable brokerage</option>
              <option value="roth_ira">Roth IRA</option>
              <option value="traditional_ira">traditional IRA</option>
            </Select>
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose} title="Close without connecting.">
            Cancel
          </Btn>
          <Btn
            variant="primary"
            disabled={busy}
            onClick={() => void submit()}
            title="Validate and store this connection server-side."
          >
            {busy ? "Connecting…" : inferredPaper ? "Connect Paper" : (
              <>
                Connect <LiveTag />
              </>
            )}
          </Btn>
        </div>
      </div>
    </Sheet>
  );
}
