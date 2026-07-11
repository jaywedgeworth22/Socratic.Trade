import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Operator admin — Socratic Trade"
};

/** Operator admin hub — one place for the server-wide diagnostic pages that were previously only
 *  reachable as scattered links under Settings. Also the landing page for admin.socratictrade.com
 *  (see docs for the DNS + env setup). These routes require login; each page's data endpoint
 *  (/api/admin/*) independently enforces operator rights. */
const ADMIN_PAGES = [
  {
    href: "/admin/connections",
    title: "API connections health",
    desc: "Live status of every upstream data/broker connection the server uses."
  },
  {
    href: "/admin/llm-usage",
    title: "LLM usage & cost",
    desc: "Token and dollar spend per model and per day, across all users."
  },
  {
    href: "/admin/rag-coverage",
    title: "RAG coverage",
    desc: "What the retrieval index covers and where it is thin."
  },
  {
    href: "/admin/server",
    title: "Server & infrastructure",
    desc: "Real-time metrics, host resource utilization, and Coolify container statuses."
  },
  {
    href: "/admin/transcript",
    title: "Chat transcript",
    desc: "Raw assistant transcript view for debugging conversations."
  }
];

export default function AdminIndexPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-bold text-fg">Operator admin</h1>
        <p className="mt-1 text-sm text-muted">
          Server-wide diagnostics. Data endpoints enforce operator rights, so non-operators see empty views.
        </p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2">
        {ADMIN_PAGES.map((p) => (
          <Link
            key={p.href}
            href={p.href}
            className="rounded-xl border border-line bg-surface p-4 transition-colors hover:border-accent"
          >
            <div className="font-semibold text-fg">{p.title}</div>
            <p className="mt-1 text-sm text-muted">{p.desc}</p>
          </Link>
        ))}
      </div>
      <p className="mt-8 text-xs text-faint">
        Also reachable from Settings → Operator, and at admin.socratictrade.com once its DNS + env are configured.
      </p>
    </div>
  );
}
