// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Sheet } from "../app/console/ui/sheet";

function Harness() {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button data-testid="opener" onClick={() => setOpen(true)}>
        Open sheet
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Sheet title">
        <input data-testid="field" />
        <button data-testid="action">Action</button>
      </Sheet>
    </div>
  );
}

function pressKey(target: EventTarget, key: string, shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, shiftKey });
  target.dispatchEvent(event);
  return event;
}

describe("console sheet focus trap", () => {
  let container: HTMLDivElement | undefined;
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("moves focus into the sheet, cycles tab order, and restores the opener on close", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const mountedRoot = createRoot(container);
    root = mountedRoot;

    await act(async () => {
      mountedRoot.render(<Harness />);
    });

    const opener = container.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
    opener.focus();

    await act(async () => {
      opener.click();
    });

    const closeButton = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
    const action = container.querySelector<HTMLButtonElement>('[data-testid="action"]')!;

    expect(document.activeElement).toBe(closeButton);

    opener.focus();
    expect(document.activeElement).toBe(closeButton);

    action.focus();
    const tabEvent = pressKey(action, "Tab");
    expect(tabEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(closeButton);

    closeButton.focus();
    const shiftTabEvent = pressKey(closeButton, "Tab", true);
    expect(shiftTabEvent.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(action);

    await act(async () => {
      const escapeEvent = pressKey(action, "Escape");
      expect(escapeEvent.defaultPrevented).toBe(true);
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
