"use client";

/** Modal sheet: centered dialog on desktop, bottom sheet on mobile.
 *  `tone="live"` adds the real-money border treatment. */

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cx } from "../lib/format";
import { useOverlay } from "./use-overlay";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableElements(root: HTMLElement | null) {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => !el.hasAttribute("disabled"));
}

function focusElement(el: HTMLElement | null) {
  if (!el) return;
  try {
    el.focus({ preventScroll: true });
  } catch {
    el.focus();
  }
}

export function nextSheetFocusTarget<T>(
  focusables: T[],
  active: T | null,
  sheet: T,
  shiftKey: boolean,
  activeIsInside: boolean
): T | null {
  if (focusables.length === 0) return sheet;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (!activeIsInside) return first ?? sheet;
  if (shiftKey && (active === first || active === sheet)) return last ?? sheet;
  if (!shiftKey && active === last) return first ?? sheet;
  return null;
}

export function Sheet({
  open,
  onClose,
  title,
  tone,
  wide,
  children
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  tone?: "live";
  /** Widens the desktop dialog (920px vs the default 560px) for content that
   *  needs more horizontal room, e.g. a multi-column table. Mobile bottom
   *  sheet stays full-width either way. */
  wide?: boolean;
  children: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const headingId = useId();
  const overlayId = useId();

  useOverlay(overlayId, open, onClose);

  // Keep the latest onClose without making it a dependency of the FOCUS effect below. Callers pass
  // an inline arrow (e.g. `() => setOpen(false)`) that is a NEW reference on every render, so if the
  // focus effect depended on onClose it would re-run on every parent re-render — including on each
  // keystroke in a TypedConfirm field — and re-focus the first focusable element (the header X),
  // yanking the caret out of the input. The focus effect now depends only on `open`; this tiny
  // effect just keeps the ref current (writing the ref during render trips react-hooks lint).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const sheet = sheetRef.current;
    const active = document.activeElement;
    openerRef.current =
      active instanceof HTMLElement && active !== document.body && active !== document.documentElement ? active : null;

    const focusables = getFocusableElements(sheet);
    focusElement(focusables[0] ?? sheet);

    const onKey = (e: KeyboardEvent) => {
      const currentSheet = sheetRef.current;
      if (!currentSheet) return;

      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }

      if (e.key !== "Tab") return;

      const tabbables = getFocusableElements(currentSheet);
      const active = document.activeElement;
      const isInside = active instanceof Node ? currentSheet.contains(active) : false;
      const target = nextSheetFocusTarget(
        tabbables,
        active instanceof HTMLElement ? active : null,
        currentSheet,
        e.shiftKey,
        isInside
      );
      if (target) {
        e.preventDefault();
        focusElement(target);
      }
    };

    let isFocusing = false;
    const onFocusIn = (e: FocusEvent) => {
      if (isFocusing) return;
      const currentSheet = sheetRef.current;
      if (!currentSheet || !currentSheet.isConnected) return;
      if (e.target instanceof Node && currentSheet.contains(e.target)) return;
      
      isFocusing = true;
      try {
        const tabbables = getFocusableElements(currentSheet);
        focusElement(tabbables[0] ?? currentSheet);
      } finally {
        isFocusing = false;
      }
    };

    window.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener && opener.isConnected) focusElement(opener);
    };
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div className="con-scrim" onClick={onClose} aria-hidden />
      <div
        ref={sheetRef}
        className={cx("con-sheet", wide && "con-sheet-wide", tone === "live" && "con-sheet-live")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? headingId : undefined}
        tabIndex={-1}
      >
        <header className="flex items-center justify-between gap-4 border-b border-[color:var(--con-line)] px-5 py-3.5">
          <h2 id={headingId} className="text-[length:var(--con-fs-md)] font-semibold">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            className="con-icon-btn"
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
