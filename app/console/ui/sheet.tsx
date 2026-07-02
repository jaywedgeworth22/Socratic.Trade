"use client";

/** Modal sheet: centered dialog on desktop, bottom sheet on mobile.
 *  `tone="live"` adds the real-money border treatment. */

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { cx } from "../lib/format";

export function Sheet({
  open,
  onClose,
  title,
  tone,
  children
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  tone?: "live";
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="con-scrim" onClick={onClose} aria-hidden />
      <div className={cx("con-sheet", tone === "live" && "con-sheet-live")} role="dialog" aria-modal="true">
        <header className="flex items-center justify-between gap-4 border-b border-[color:var(--con-line)] px-5 py-3.5">
          <h2 className="text-[length:var(--con-fs-md)] font-semibold">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            className="text-[color:var(--con-faint)] transition-colors hover:text-[color:var(--con-fg)]"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
      </div>
    </>
  );
}
