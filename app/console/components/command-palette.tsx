"use client";

/** Console command palette (⌘K / Ctrl+K). A from-anywhere jump to any of the console
 *  destinations plus a few safe global actions. Console-native (con-* tokens, mounts inside
 *  .console-root). Opens on the ⌘K/Ctrl+K chord or the chrome trigger button; arrow keys +
 *  Enter to run, Escape to close. Navigation uses the router — the beforeunload dirty guard
 *  still catches a tab close; in-console unsaved-draft interception on palette jumps is a
 *  deliberate v1 gap, not a silent one. */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft, Search } from "lucide-react";
import { DESTINATIONS } from "./nav";
import { useConsoleTheme } from "../lib/useConsoleTheme";
import { cx } from "../lib/format";

const CMDK_EVENT = "console:open-command-palette";

interface Command {
  id: string;
  label: string;
  hint?: string;
  keywords: string;
  run: () => void;
}

/** True on Apple platforms (so we show ⌘ rather than Ctrl). Resolved after mount to avoid
 *  an SSR/client hydration mismatch — defaults to the ⌘ label, corrected on the client. */
function useIsApple(): boolean {
  const [apple, setApple] = useState(true);
  useEffect(() => {
    const p = typeof navigator !== "undefined" ? `${navigator.platform} ${navigator.userAgent}` : "";
    setApple(/Mac|iPhone|iPad|iPod/i.test(p));
  }, []);
  return apple;
}

/** Compact chrome button that advertises and opens the palette. */
export function CommandPaletteTrigger() {
  const apple = useIsApple();
  return (
    <button
      type="button"
      className="con-cmdk-trigger"
      title="Search and jump to any screen (⌘K / Ctrl+K)"
      aria-label="Open command palette"
      onClick={() => window.dispatchEvent(new Event(CMDK_EVENT))}
    >
      <Search size={14} />
      <kbd>{apple ? "⌘K" : "Ctrl K"}</kbd>
    </button>
  );
}

export function CommandPalette() {
  const router = useRouter();
  const { cycle } = useConsoleTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(CMDK_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(CMDK_EVENT, onOpen);
    };
  }, []);

  const commands = useMemo<Command[]>(
    () => [
      ...DESTINATIONS.map((d) => ({
        id: `nav:${d.href}`,
        label: d.label,
        hint: d.desc,
        keywords: `${d.label} ${d.href} ${d.desc}`.toLowerCase(),
        run: () => router.push(d.href)
      })),
      {
        id: "action:theme",
        label: "Toggle theme",
        hint: "Cycle light / dark / follow system",
        keywords: "toggle theme dark light mode appearance system",
        run: cycle
      }
    ],
    [router, cycle]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.keywords.includes(q));
  }, [commands, query]);

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  useEffect(() => {
    if (open) {
      setQuery("");
      // focus after the node mounts
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const runAt = (i: number) => {
    const cmd = filtered[i];
    if (!cmd) return;
    setOpen(false);
    cmd.run();
  };

  if (!open) return null;

  return (
    <div
      className="con-cmdk-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={() => setOpen(false)}
    >
      <div className="con-cmdk" onMouseDown={(e) => e.stopPropagation()}>
        <div className="con-cmdk-search">
          <Search size={16} aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a screen or action…"
            aria-label="Search commands"
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                runAt(active);
              }
            }}
          />
          <kbd className="con-kbd">esc</kbd>
        </div>
        <ul className="con-cmdk-list" ref={listRef} role="listbox" aria-label="Commands">
          {filtered.length === 0 ? (
            <li className="con-cmdk-empty">No matches</li>
          ) : (
            filtered.map((c, i) => (
              <li
                key={c.id}
                role="option"
                aria-selected={i === active}
                data-active={i === active}
                className={cx("con-cmdk-item")}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  runAt(i);
                }}
              >
                <span className="con-cmdk-item-label">{c.label}</span>
                {c.hint && <span className="con-cmdk-item-hint">{c.hint}</span>}
                {i === active && <CornerDownLeft size={13} className="con-cmdk-enter" aria-hidden />}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
