"use client";

import type { Dispatch, SetStateAction } from "react";
import {
  Activity,
  Bell,
  Check,
  CircleStop,
  Loader2,
  Plus,
  ShieldAlert,
  Trash2,
  Wifi,
  WifiOff
} from "lucide-react";
import type { StateInfo } from "../../console/lib/derive";
import { authorityLabel } from "../../console/lib/labels";
import type {
  DeletionRequest,
  MobileCommand,
  MobileCommandAvailability,
  MobileSnapshot,
  MobileSnapshotFreshness
} from "../mobile-pwa-client";
import {
  commandLabel,
  marketSessionLabel,
  nextDraftAfterCommandAcceptance,
  strategyAuthorityLabel
} from "../mobile-pwa-client";

function statusTone(status: string): string {
  if (status === "succeeded") {
    return "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200";
  }
  if (status === "failed") return "border-red-300 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200";
  if (status === "running") return "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200";
  return "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200";
}

function money(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function shortTime(value?: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleTimeString([], { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-h-20 rounded-md border border-line bg-surface p-3">
      <p className="text-xs uppercase tracking-wide text-faint">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold">{value}</p>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed border-line px-3 py-4 text-center text-sm text-faint">
      {label}
    </div>
  );
}

export function MobileHomeTab({
  snapshot,
  runState,
  commandAvailability,
  busyKey,
  activeCommand,
  positions,
  watchlist,
  alerts,
  symbolInput,
  setSymbolInput,
  alertInput,
  setAlertInput,
  dangerZoneOpen,
  setDangerZoneOpen,
  deletionRequest,
  deleteIdentity,
  setDeleteIdentity,
  deletePhrase,
  setDeletePhrase,
  deleteBusy,
  snapshotFreshness,
  lastSnapshotAt,
  isOnline,
  onSubmitCommand,
  onStartDeletion,
  onConfirmDeletion
}: {
  snapshot: MobileSnapshot;
  runState: StateInfo | null;
  commandAvailability: MobileCommandAvailability;
  busyKey: string | null;
  activeCommand: MobileCommand | undefined;
  positions: Array<{ symbol: string; quantity: number; marketValue: number; averageCost?: number }>;
  watchlist: Array<{ symbol: string; addedAt: string }>;
  alerts: Array<{ id: string; symbol: string; op: string; price: number; status: string }>;
  symbolInput: string;
  setSymbolInput: (val: string) => void;
  alertInput: { symbol: string; op: string; price: string };
  setAlertInput: Dispatch<SetStateAction<{ symbol: string; op: string; price: string }>>;
  dangerZoneOpen: boolean;
  setDangerZoneOpen: (open: boolean) => void;
  deletionRequest: DeletionRequest | null;
  deleteIdentity: string;
  setDeleteIdentity: (val: string) => void;
  deletePhrase: string;
  setDeletePhrase: (val: string) => void;
  deleteBusy: boolean;
  snapshotFreshness: MobileSnapshotFreshness;
  lastSnapshotAt: string | null;
  isOnline: boolean;
  onSubmitCommand: (commandType: string, payload?: Record<string, unknown>, opts?: { key?: string }) => Promise<boolean>;
  onStartDeletion: () => void;
  onConfirmDeletion: () => void;
}) {
  return (
    <div className="space-y-4">
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-faint">Mode</p>
            <p className="text-xl font-semibold" title={runState?.detail}>
              {runState?.word ?? "unknown"}
            </p>
          </div>
          <div className="rounded-md border border-line bg-surface px-3 py-2 text-right">
            <p className="text-xs text-faint">Authority</p>
            <p
              className="text-sm font-medium"
              title={authorityLabel(snapshot.readiness.strategyAuthority).title || undefined}
            >
              {strategyAuthorityLabel(snapshot.readiness.strategyAuthority)}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            className="flex min-h-12 items-center justify-center gap-2 rounded-md bg-emerald-500 px-3 text-sm font-semibold text-black disabled:opacity-50"
            disabled={!commandAvailability.canSubmitTrading}
            onClick={() => void onSubmitCommand("strategy.run_once")}
          >
            {busyKey === "strategy.run_once" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
            Run once
          </button>
          <button
            className="flex min-h-12 items-center justify-center gap-2 rounded-md bg-accent px-3 text-sm font-semibold text-accent-fg disabled:opacity-50"
            disabled={!commandAvailability.canSubmitTrading}
            onClick={() => void onSubmitCommand("strategy.start")}
          >
            {busyKey === "strategy.start" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wifi className="h-4 w-4" />}
            Start
          </button>
          <button
            className="flex min-h-12 items-center justify-center gap-2 rounded-md border border-line bg-surface px-3 text-sm font-semibold text-fg disabled:opacity-50"
            disabled={!commandAvailability.canSubmitAccountCommand}
            onClick={() => void onSubmitCommand("strategy.close_only")}
          >
            {busyKey === "strategy.close_only" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
            Close only
          </button>
          <button
            className="flex min-h-12 items-center justify-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 text-sm font-semibold text-red-700 disabled:opacity-50 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100"
            disabled={!commandAvailability.canSubmitStop}
            onClick={() => void onSubmitCommand("strategy.stop")}
          >
            {busyKey === "strategy.stop" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleStop className="h-4 w-4" />}
            Stop
          </button>
        </div>

        {activeCommand && (
          <div className={`rounded-md border px-3 py-2 text-sm ${statusTone(activeCommand.status)}`}>
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4" />
              <span>{commandLabel(activeCommand.commandType)}</span>
              <span className="ml-auto capitalize">{activeCommand.status}</span>
            </div>
          </div>
        )}
      </section>

      <section className="grid grid-cols-2 gap-2">
        <Metric label="Equity" value={money(snapshot.portfolio?.totalMarketValue)} />
        <Metric label="Buying power" value={money(snapshot.portfolio?.buyingPower)} />
        <Metric label="Account" value={snapshot.readiness.activeConnectedAccount?.label ?? "None"} />
        <Metric label="Market" value={marketSessionLabel(snapshot.marketSession)} />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Watchlist</h2>
        <div className="flex gap-2">
          <input
            className="min-h-11 min-w-0 flex-1 rounded-md border border-line bg-surface px-3 text-base text-fg outline-none focus:border-accent"
            autoCapitalize="characters"
            placeholder="Ticker"
            value={symbolInput}
            onChange={(event) => setSymbolInput(event.target.value)}
          />
          <button
            className="grid h-11 w-11 place-items-center rounded-md bg-accent text-accent-fg disabled:opacity-50"
            disabled={!commandAvailability.canSubmit || !symbolInput.trim()}
            onClick={() => {
              const submitted = symbolInput;
              void onSubmitCommand("watchlist.add", { symbol: submitted }).then((accepted) => {
                setSymbolInput(nextDraftAfterCommandAcceptance(symbolInput, submitted, accepted, ""));
              });
            }}
            aria-label="Add ticker"
            title="Add ticker"
          >
            <Plus className="h-5 w-5" />
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {watchlist.length === 0 ? (
            <span className="text-sm text-faint">No tickers yet</span>
          ) : (
            watchlist.map((item) => (
              <button
                key={item.symbol}
                className="min-h-9 rounded-md border border-line bg-surface px-3 text-sm font-medium text-fg"
                disabled={!commandAvailability.canSubmit}
                onClick={() => void onSubmitCommand("watchlist.remove", { symbol: item.symbol })}
              >
                {item.symbol}
              </button>
            ))
          )}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Price Alerts</h2>
        <div className="grid grid-cols-[minmax(0,1fr)_76px_minmax(0,1fr)_44px] gap-2">
          <input
            className="min-h-11 min-w-0 rounded-md border border-line bg-surface px-3 text-base text-fg outline-none focus:border-accent"
            placeholder="Ticker"
            value={alertInput.symbol}
            onChange={(event) => setAlertInput((prev) => ({ ...prev, symbol: event.target.value }))}
          />
          <select
            className="min-h-11 min-w-0 rounded-md border border-line bg-surface px-2 text-base text-fg outline-none focus:border-accent"
            value={alertInput.op}
            onChange={(event) => setAlertInput((prev) => ({ ...prev, op: event.target.value }))}
            aria-label="Alert direction"
          >
            <option value=">">Above</option>
            <option value="<">Below</option>
          </select>
          <input
            className="min-h-11 min-w-0 rounded-md border border-line bg-surface px-3 text-base text-fg outline-none focus:border-accent"
            inputMode="decimal"
            placeholder="Price"
            value={alertInput.price}
            onChange={(event) => setAlertInput((prev) => ({ ...prev, price: event.target.value }))}
          />
          <button
            className="grid h-11 w-11 place-items-center rounded-md bg-accent text-accent-fg disabled:opacity-50"
            disabled={!commandAvailability.canSubmit || !alertInput.symbol.trim() || !alertInput.price.trim()}
            onClick={() => {
              const submitted = alertInput;
              void onSubmitCommand("alert.create", submitted).then((accepted) => {
                setAlertInput((current) =>
                  nextDraftAfterCommandAcceptance(current, submitted, accepted, { symbol: "", op: ">", price: "" })
                );
              });
            }}
            aria-label="Create alert"
            title="Create alert"
          >
            <Bell className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-2">
          {alerts.length === 0 ? (
            <Empty label="No alerts" />
          ) : (
            alerts.slice(0, 8).map((alert) => (
              <div key={alert.id} className="flex min-h-11 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm">
                <span className="font-semibold">{alert.symbol}</span>
                <span className="text-muted">
                  {alert.op} {money(alert.price)}
                </span>
                <span className="ml-auto capitalize text-faint">{alert.status}</span>
                <button
                  className="grid h-8 w-8 place-items-center rounded-md text-muted"
                  disabled={!commandAvailability.canSubmit}
                  onClick={() => void onSubmitCommand("alert.delete", { alertId: alert.id })}
                  aria-label={`Delete ${alert.symbol} alert`}
                  title="Delete alert"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Positions</h2>
          <span className="text-xs text-faint">{positions.length}</span>
        </div>
        {positions.length === 0 ? (
          <Empty label="No positions" />
        ) : (
          positions.slice(0, 10).map((position) => (
            <div key={position.symbol} className="flex min-h-11 items-center rounded-md border border-line bg-surface px-3 text-sm">
              <span className="font-semibold">{position.symbol}</span>
              <span className="ml-3 text-muted">{position.quantity} sh</span>
              <span className="ml-auto font-medium">{money(position.marketValue)}</span>
            </div>
          ))
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Command Log</h2>
        {(snapshot.recentCommands ?? []).length === 0 ? (
          <Empty label="No mobile commands yet" />
        ) : (
          (snapshot.recentCommands ?? []).slice(0, 8).map((command) => (
            <div key={command.id} className={`rounded-md border px-3 py-2 text-sm ${statusTone(command.status)}`}>
              <div className="flex items-center gap-2">
                {command.status === "running" || command.status === "queued" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {command.status === "failed" ? <ShieldAlert className="h-4 w-4" /> : null}
                {command.status === "succeeded" ? <Check className="h-4 w-4" /> : null}
                {command.status === "cancelled" ? <CircleStop className="h-4 w-4" /> : null}
                <span>{commandLabel(command.commandType)}</span>
                <span className="ml-auto">{shortTime(command.updatedAt)}</span>
              </div>
              {command.error && <p className="mt-1 line-clamp-3 text-xs" title={command.error}>{command.error}</p>}
            </div>
          ))
        )}
      </section>

      <section className="border-t border-line pt-4">
        {!dangerZoneOpen ? (
          <button
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-line bg-surface px-3 text-xs font-semibold text-muted hover:text-fg"
            onClick={() => setDangerZoneOpen(true)}
          >
            Delete app account…
          </button>
        ) : (
          <div className="space-y-3 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-500/30 dark:bg-red-500/5">
            <div className="flex items-start gap-3">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-200" />
              <div>
                <h2 className="text-sm font-semibold text-red-800 dark:text-red-100">Delete app account</h2>
                <p className="mt-1 text-sm leading-relaxed text-red-700 dark:text-red-100/80">
                  This deletes the backend account tied to the current Google or Apple login. Broker and provider
                  secrets stored on the server are deleted. Signing in later with the same provider creates a fresh
                  app account with no prior trading data attached.
                </p>
              </div>
            </div>

            {!deletionRequest ? (
              <div className="grid grid-cols-2 gap-2">
                <button
                  className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm font-semibold text-fg"
                  onClick={() => setDangerZoneOpen(false)}
                >
                  Keep account
                </button>
                <button
                  className="flex min-h-11 items-center justify-center gap-2 rounded-md border border-red-300 bg-red-100 px-3 text-sm font-semibold text-red-800 disabled:opacity-50 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100"
                  disabled={deleteBusy}
                  onClick={onStartDeletion}
                >
                  <Trash2 className="h-4 w-4" />
                  Start deletion steps
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <ol className="list-decimal space-y-1 pl-5 text-sm text-red-700 dark:text-red-100/80">
                  {deletionRequest.steps.map((step, index) => (
                    <li key={`${index}-${step}`}>{step}</li>
                  ))}
                </ol>
                <input
                  className="min-h-11 w-full rounded-md border border-red-200 bg-bg px-3 text-base text-fg outline-none focus:border-red-400 dark:border-red-500/30 dark:focus:border-red-300"
                  placeholder={deletionRequest.email ? "Type signed-in email" : "Type app user id"}
                  value={deleteIdentity}
                  onChange={(event) => setDeleteIdentity(event.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                />
                <input
                  className="min-h-11 w-full rounded-md border border-red-200 bg-bg px-3 text-base text-fg outline-none focus:border-red-400 dark:border-red-500/30 dark:focus:border-red-300"
                  placeholder="Type required phrase"
                  value={deletePhrase}
                  onChange={(event) => setDeletePhrase(event.target.value)}
                  autoCapitalize="characters"
                  autoCorrect="off"
                />
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <button
                    className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm font-semibold text-fg"
                    onClick={() => {
                      setDangerZoneOpen(false);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="flex min-h-11 items-center justify-center gap-2 rounded-md bg-red-600 px-3 text-sm font-semibold text-white disabled:opacity-50"
                    disabled={
                      deleteBusy ||
                      deleteIdentity.trim().toLowerCase() !== (deletionRequest.email ?? deletionRequest.userId).toLowerCase() ||
                      deletePhrase.trim() !== deletionRequest.requiredText
                    }
                    onClick={onConfirmDeletion}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete and sign out
                  </button>
                </div>
                <p className="text-xs text-red-700/80 dark:text-red-100/70">
                  This resets the backend account. OAuth access at Google or Apple is provider-side; revoke it in
                  that account's security settings if you also want to remove this app from your provider account.
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      <footer className="space-y-1 py-3 text-center text-xs text-faint">
        <div className="flex items-center justify-center gap-2">
          <Wifi className="h-3.5 w-3.5" />
          Backend is source of truth. No broker/provider secrets are stored on this device.
        </div>
        <p>
          Snapshot {snapshotFreshness === "fresh" ? `updated ${shortTime(lastSnapshotAt)}` : snapshotFreshness}
        </p>
      </footer>
    </div>
  );
}
