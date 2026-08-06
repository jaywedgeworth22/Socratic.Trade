"use client";

/** Shared market-data pool consent gate — the console port of the legacy
 *  blocking dialog (app/dashboard-client.tsx ConsentGate). Semantics are
 *  identical, deliberately un-weakened:
 *  - GET /api/consent → needsConsent true ⇒ a blocking overlay until the user
 *    explicitly agrees or declines (POST /api/consent).
 *  - Answering resolves the gate for this session; the server records the
 *    choice. Either answer can be changed later in Settings → Data sharing.
 *  Scope honesty: only GENERAL market data is ever pooled — personal account
 *  data (positions, orders, balances, P&L, credentials) is never shared. */

import { useEffect, useRef, useState } from "react";
import { Network } from "lucide-react";
import { Btn } from "../ui/primitives";
import { useFocusTrap } from "../ui/focus-trap";

type GateState = "loading" | "needed" | "done";

export function ConsentGate() {
  const [state, setState] = useState<GateState>("loading");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // The backdrop only blocks the POINTER; keyboard focus walks straight past it into the
  // console behind. The trap is what makes "blocks all interaction beneath" true, and
  // `blocking` tells the rest of the console chrome (the command palette) not to open on
  // top of an unanswered gate. Deliberately no `onEscape`: this gate has exactly two
  // answers, and dismissing it is not one of them. Initial focus lands on Decline, the
  // first focusable — the conservative default if someone hits Enter on reflex.
  useFocusTrap(dialogRef, state === "needed", { blocking: true });

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/consent", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ needsConsent?: boolean }>) : null))
      .then((data) => {
        if (cancelled) return;
        setState(data?.needsConsent === true ? "needed" : "done");
      })
      .catch(() => {
        // Fail CLOSED like the legacy gate: if the consent state can't be read,
        // ask rather than silently proceed.
        if (!cancelled) setState("needed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const respond = async (accepted: boolean) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accepted })
      });
      if (!res.ok) throw new Error("Consent could not be saved.");
      setState("done");
    } catch {
      setError("Your answer could not be saved. The console stays locked until this is resolved — try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (state !== "needed") return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="con-consent-title"
      aria-describedby="con-consent-body"
      className="fixed inset-0 z-[200] flex items-center justify-center p-4"
    >
      {/* Opaque backdrop — blocks all interaction beneath until answered. */}
      <div className="absolute inset-0" style={{ background: "var(--con-scrim)" }} aria-hidden />
      <div className="con-card relative z-10 flex w-full max-w-lg flex-col gap-4 p-6">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-[color:var(--con-accent-soft)] text-[color:var(--con-accent)]">
            <Network size={20} />
          </span>
          <div>
            <h2 id="con-consent-title" className="text-[length:var(--con-fs-md)] font-semibold">
              Shared market-data pool
            </h2>
            <p className="mt-0.5 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
              Can be changed later in Settings → Data sharing
            </p>
          </div>
        </div>

        <div id="con-consent-body" className="space-y-3 text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">
          <p>
            When enabled, general market data you pull through your own API keys or broker connection — quotes,
            fundamentals, price history, and news — is contributed to a shared cache that other consenting users can
            read. In return, you read data others have contributed, reducing API spend and enriching everyone&apos;s
            market view.
          </p>
          <p>
            <strong className="font-semibold text-[color:var(--con-fg)]">Your personal account data is never shared.</strong>{" "}
            Positions, orders, balances, P&amp;L, and credentials remain private to your account; credentials stay
            encrypted and server-only.
          </p>
        </div>

        {error && <p className="text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-warn)]">{error}</p>}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Btn
            variant="outline"
            disabled={submitting}
            onClick={() => void respond(false)}
            title="Say no. You use only your own data; nothing you pull is pooled."
          >
            Decline
          </Btn>
          <Btn
            variant="primary"
            disabled={submitting}
            onClick={() => void respond(true)}
            title="Opt in to the shared general-market-data cache. Personal account data is never included."
          >
            {submitting ? "Saving…" : "Agree & continue"}
          </Btn>
        </div>

        <p className="text-center text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          You can enable or disable pooling at any time under Settings → Data sharing.
        </p>
      </div>
    </div>
  );
}
