"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { X } from "lucide-react";

interface SymbolDrawerContent {
  title: ReactNode;
  ariaLabel: string;
  body: ReactNode;
}

interface SymbolDrawerApi {
  openDrawer: (content: SymbolDrawerContent) => void;
  updateDrawerTitle: (ariaLabel: string, title: ReactNode) => void;
  closeDrawer: () => void;
}

const SymbolDrawerContext = createContext<SymbolDrawerApi | null>(null);

export function SymbolDrawerProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<SymbolDrawerContent | null>(null);

  const closeDrawer = useCallback(() => setContent(null), []);
  const updateDrawerTitle = useCallback((ariaLabel: string, title: ReactNode) => {
    setContent((current) =>
      current?.ariaLabel === ariaLabel ? { ...current, title } : current
    );
  }, []);
  const api = useMemo<SymbolDrawerApi>(
    () => ({
      openDrawer: setContent,
      updateDrawerTitle,
      closeDrawer
    }),
    [closeDrawer, updateDrawerTitle]
  );

  useEffect(() => {
    if (!content) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDrawer, content]);

  return (
    <SymbolDrawerContext.Provider value={api}>
      {children}
      {content && <SymbolDrawerHost content={content} onClose={closeDrawer} />}
    </SymbolDrawerContext.Provider>
  );
}

export function useSymbolDrawer() {
  const context = useContext(SymbolDrawerContext);
  if (!context) throw new Error("useSymbolDrawer must be used inside SymbolDrawerProvider");
  return context;
}

function SymbolDrawerHost({ content, onClose }: { content: SymbolDrawerContent; onClose: () => void }) {
  return (
    <>
      <div className="con-drawer-scrim" onClick={onClose} aria-hidden />
      <aside className="con-drawer" role="dialog" aria-modal="true" aria-label={content.ariaLabel} tabIndex={-1}>
        <header className="con-drawer-header">
          <h2 className="min-w-0 text-[length:var(--con-fs-md)] font-semibold">{content.title}</h2>
          <button
            type="button"
            aria-label="Close"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[color:var(--con-faint)] transition-colors hover:bg-[color:var(--con-surface-2)] hover:text-[color:var(--con-fg)]"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="con-drawer-body">{content.body}</div>
      </aside>
    </>
  );
}
