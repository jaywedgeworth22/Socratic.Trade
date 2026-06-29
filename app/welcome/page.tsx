import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, buttonClass } from "../ui/primitives";

export const metadata: Metadata = {
  title: "AI market research & strategy dashboard",
  description:
    "AI-assisted dashboard for researching markets, testing strategies in a connected paper account (e.g. Alpaca Paper Trading), and running a transparent, risk-controlled trading workflow you stay in control of. Not investment advice.",
  alternates: { canonical: "/welcome" },
  openGraph: {
    type: "website",
    siteName: "Trading Dashboard",
    url: "/welcome",
    title: "AI market research & strategy dashboard",
    description:
      "AI-assisted dashboard for market research, paper trading via a connected broker (e.g. Alpaca Paper Trading), and a transparent, risk-controlled trading workflow. Not investment advice."
  },
  twitter: {
    card: "summary_large_image",
    title: "AI market research & strategy dashboard",
    description: "AI-assisted market research + paper trading via a connected broker. Not investment advice."
  },
  robots:
    process.env.NEXT_PUBLIC_ALLOW_INDEXING === "true"
      ? { index: true, follow: true }
      : { index: false, follow: false, nocache: true }
};

const ACCESS_HREF =
  "mailto:mail@jays.services?subject=Trading%20dashboard%20access";

const FEATURES: Array<{ title: string; body: string }> = [
  {
    title: "Market scanning & enrichment",
    body: "Screen hundreds of tickers and pull in fundamentals, technicals, news, and alternative data from multiple sources in a single pass."
  },
  {
    title: "Multi-lens evaluation",
    body: "Each candidate is scored across independent research lenses — valuation, momentum, sentiment, risk — so you see a rounded picture, not a single signal."
  },
  {
    title: "Paper trading via a connected broker",
    body: "Connect a third-party paper account — e.g. Alpaca Paper Trading — and run every strategy against it before risking real capital. No money at risk."
  },
  {
    title: "Transparent strategy & learning loop",
    body: "The system records its reasoning for every decision and surfaces what worked and what did not, building an auditable track record you can inspect."
  },
  {
    title: "Risk controls & approval gates",
    body: "Configurable position limits, concentration caps, and daily-loss guards. High-confidence proposals can be queued for your explicit approval before any order is placed."
  },
  {
    title: "You stay in control",
    body: "The dashboard surfaces research and proposals. You decide. No autonomous real-money trading without your say-so."
  }
];

const STEPS: Array<{ n: number; title: string; detail: string }> = [
  {
    n: 1,
    title: "Scan & enrich the market",
    detail:
      "The system scans your watchlist and a broader universe, enriching each symbol with fundamentals, technicals, recent news, and alternative signals."
  },
  {
    n: 2,
    title: "Evaluate candidates across lenses",
    detail:
      "An AI-assisted research panel scores each candidate across multiple independent lenses and surfaces the strongest ideas with supporting evidence."
  },
  {
    n: 3,
    title: "Test in a connected paper account and decide — you approve",
    detail:
      "Promising ideas can be routed to a connected third-party paper account (e.g. Alpaca Paper Trading). If you choose to act on one in your real account, you review and approve each order before it is sent."
  }
];

export default function WelcomePage() {
  if (process.env.LANDING_PAGE_ENABLED !== "true") notFound();

  return (
    <>
      {/* JSON-LD structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: "Trading Dashboard",
            applicationCategory: "FinanceApplication",
            operatingSystem: "Web",
            description:
              "AI-assisted dashboard for market research, paper trading via a connected broker (e.g. Alpaca Paper Trading), and a transparent, risk-controlled trading workflow.",
            offers: { "@type": "Offer", price: "0", priceCurrency: "USD" }
          })
        }}
      />

      <div className="min-h-screen bg-bg text-fg">
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <header className="border-b border-line bg-surface/80 backdrop-blur-sm">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <span className="text-base font-semibold text-fg">Trading Dashboard</span>
            <a href={ACCESS_HREF} className={buttonClass({ variant: "primary", size: "sm" })}>
              Request access
            </a>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-6 py-16 space-y-20">
          {/* ── Hero ───────────────────────────────────────────────────────── */}
          <section className="text-center space-y-6">
            <h1 className="text-4xl font-bold tracking-tight text-fg sm:text-5xl">
              AI market research &amp; strategy dashboard
            </h1>
            <p className="mx-auto max-w-2xl text-lg text-muted leading-relaxed">
              Scan and enrich markets, evaluate ideas across multiple research lenses, test
              strategies in a connected paper account (e.g. Alpaca Paper Trading), and — when you
              are ready — run a transparent, risk-controlled workflow where you approve every order.
            </p>
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
              <a href={ACCESS_HREF} className={buttonClass({ variant: "primary", size: "md" })}>
                Request access
              </a>
              <a href="/strategy" className={buttonClass({ variant: "ghost", size: "md" })}>
                How the strategy works
              </a>
            </div>
            <p className="text-sm text-faint">Currently in private beta.</p>
          </section>

          {/* ── Features grid ──────────────────────────────────────────────── */}
          <section className="space-y-6">
            <h2 className="text-xl font-semibold text-fg">What it does</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <Card key={f.title} className="p-5 space-y-2">
                  <h3 className="text-sm font-semibold text-fg">{f.title}</h3>
                  <p className="text-sm text-muted leading-relaxed">{f.body}</p>
                </Card>
              ))}
            </div>
            <p className="text-xs text-faint leading-relaxed">
              Try the workflow instantly with the built-in local simulator (&ldquo;Test &mdash; Local Sim&rdquo;,
              no broker required), or connect a third-party paper account such as Alpaca Paper Trading &mdash;
              which is likely more realistic than the local simulation.
            </p>
          </section>

          {/* ── How it works ───────────────────────────────────────────────── */}
          <section className="space-y-6">
            <h2 className="text-xl font-semibold text-fg">How it works</h2>
            <ol className="space-y-4">
              {STEPS.map((s) => (
                <li key={s.n} className="flex gap-4">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg text-sm font-bold">
                    {s.n}
                  </span>
                  <div className="space-y-1 pt-1">
                    <p className="text-sm font-semibold text-fg">{s.title}</p>
                    <p className="text-sm text-muted leading-relaxed">{s.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {/* ── Strategy overview link ─────────────────────────────────────── */}
          <section className="space-y-3 text-center">
            <h2 className="text-xl font-semibold text-fg">How the strategy works</h2>
            <p className="mx-auto max-w-2xl text-sm text-muted leading-relaxed">
              An AI reads market data and argues with itself about whether a trade is a good idea; only if the
              idea survives that argument do hard-coded safety rules let a small order through &mdash; and the
              system keeps score so it can improve. We are upfront about where it is weak or unproven.
            </p>
            <a href="/strategy" className={buttonClass({ variant: "ghost", size: "sm" })}>
              Read the full strategy overview
            </a>
          </section>

          {/* ── Disclosures ────────────────────────────────────────────────── */}
          <section>
            <Card className="p-6 space-y-4 border-line-strong">
              <h2 className="text-base font-semibold text-fg">Important disclosures</h2>
              <p className="text-sm text-muted leading-relaxed">
                This dashboard is software for market research and strategy simulation. It is not
                investment advice, and it is not a broker-dealer or a registered investment adviser.
              </p>
              <p className="text-sm text-muted leading-relaxed">
                Trading and investing involve substantial risk of loss. Simulated or hypothetical
                performance has inherent limitations and is not a guarantee of future results.
                Nothing here is a recommendation to buy or sell any security.
              </p>
              <p className="text-sm text-muted leading-relaxed">
                You are solely responsible for your own investment decisions. Consult a licensed
                financial professional before trading.
              </p>
            </Card>
          </section>
        </main>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <footer className="border-t border-line mt-8">
          <div className="mx-auto max-w-5xl px-6 py-8 flex flex-col items-center gap-2 text-center sm:flex-row sm:justify-between">
            <p className="text-xs text-faint">
              Not investment advice. Trading involves risk of loss.
            </p>
            <p className="text-xs text-faint">
              &copy; 2026 Trading Dashboard &middot;{" "}
              <a
                href="mailto:mail@jays.services"
                className="underline underline-offset-2 hover:text-muted"
              >
                mail@jays.services
              </a>
            </p>
          </div>
        </footer>
      </div>
    </>
  );
}
