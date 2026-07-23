import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isBlockedFrameworkClient } from "./ua-gate";
import { FrameworkViewer } from "./framework-viewer";

// Human-eyes-only page: always dynamic (per-request UA gate), never indexed,
// never cached, and the actual content is client-fetched from a gated API so
// it appears in neither this HTML document nor any client JS chunk. Layered
// with a Cloudflare WAF UA rule at the edge and robots/noai directives.
// Long-form source of truth: docs/trading-framework.md.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Trading framework",
  description: "How Socratic Trade turns market data into accountable trading decisions.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    noarchive: true,
    nosnippet: true,
    noimageindex: true,
    googleBot: { index: false, follow: false, noimageindex: true }
  },
  other: { "tdm-reservation": "1" }
};

const PRIMARY_LINK_SM =
  "inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg shadow-sm transition-colors hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 max-sm:min-h-11";

export default async function FrameworkPage() {
  const h = await headers();
  if (isBlockedFrameworkClient(h.get("user-agent"))) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="border-b border-line bg-surface/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <span className="text-base font-semibold text-fg">Socratic Trade</span>
          <a href="/welcome" className={PRIMARY_LINK_SM}>
            Home
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-14">
        <noscript>
          <p className="py-24 text-center text-sm text-muted">
            This page is shown to human readers in a browser and requires JavaScript.
          </p>
        </noscript>
        <FrameworkViewer />
      </main>

      <footer className="border-t border-line mt-8">
        <div className="mx-auto max-w-4xl px-6 py-8 flex flex-col items-center gap-2 text-center sm:flex-row sm:justify-between">
          <p className="text-xs text-faint">
            Not investment advice. Trading involves risk of loss.{" "}
            <a href="/welcome" className="underline underline-offset-2 hover:text-muted">
              Home
            </a>
          </p>
          <p className="text-xs text-faint">
            &copy; 2026 Socratic Trade &middot;{" "}
            <a href="mailto:mail@jays.services" className="underline underline-offset-2 hover:text-muted">
              mail@jays.services
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
