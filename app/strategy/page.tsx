import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, buttonClass } from "../ui/primitives";

export const metadata: Metadata = {
  title: "How the strategy works",
  description:
    "An honest, plain-English explanation of how Agentic Trading's AI-assisted strategy evaluates stocks, makes decisions, and learns — including its real limitations and risks. Not investment advice.",
  alternates: { canonical: "/strategy" },
  openGraph: {
    type: "website",
    siteName: "Agentic Trading",
    url: "/strategy",
    title: "How the strategy works · Agentic Trading",
    description:
      "How the AI-assisted strategy evaluates stocks, makes decisions, and learns — including its real limitations and risks. Not investment advice."
  },
  twitter: {
    card: "summary_large_image",
    title: "How the strategy works · Agentic Trading",
    description:
      "Honest explanation of the AI-assisted strategy: six research lenses, deterministic safety rules, and real limitations. Not investment advice."
  },
  robots:
    process.env.NEXT_PUBLIC_ALLOW_INDEXING === "true"
      ? { index: true, follow: true }
      : { index: false, follow: false, nocache: true }
};

const CORE_LOOP: Array<{ title: string; body: string }> = [
  {
    title: "Watch a curated list",
    body: "The system only considers stocks you pre-approve — a custom watchlist or a snapshot of the S&P 500. It cannot act on anything outside that list."
  },
  {
    title: "Pull in data",
    body: "For each candidate it gathers price data, company-health metrics, recent news, and alternative signals (e.g. insider filings). Free-tier data is real but may be delayed; optional paid sources add depth."
  },
  {
    title: "AI proposes trades with reasons",
    body: "A large language model evaluates each candidate across multiple research lenses and writes a proposal explaining the reasoning — including a built-in adversarial challenge that tries to shoot the idea down."
  },
  {
    title: "Safety rules gate everything",
    body: "Hard-coded, non-AI policy rules have the final say. The AI cannot talk its way past them. Defaults: max $10 per order, max $500 per day, max 10 orders per day, 25% concentration limit per stock."
  },
  {
    title: "Show proposals or place small orders",
    body: "By default the system only shows you proposals and waits for your approval. Automatic order placement must be explicitly enabled and is still subject to every limit above."
  },
  {
    title: "Record & grade decisions",
    body: "Every executed trade is logged with the market conditions, the reasoning, and the trade type. The system later grades itself on what actually made or lost money — not how good the reasoning sounded."
  }
];

const SIX_LENSES: Array<{ name: string; question: string; detail: string }> = [
  {
    name: "Macro / market regime",
    question: "What is the overall weather?",
    detail:
      "Broad market trend, the VIX fear gauge, interest-rate direction, inflation, and long-term themes. Sets the mood: bolder when calm, more cautious when stressed."
  },
  {
    name: "Fundamentals",
    question: "Is this a healthy company at a fair price?",
    detail:
      "Price relative to earnings, earnings growth, free cash flow, and debt load. Favors solid companies at reasonable valuations; can flag deteriorating ones as short candidates."
  },
  {
    name: "Technicals",
    question: "Even if it is a good company, is the timing right?",
    detail:
      "Price-chart trends, overbought/oversold signals, and unusual volume spikes. Helps avoid buying into a falling stock or chasing one that has already run far."
  },
  {
    name: "News & sentiment",
    question: "Is something happening right now that could move the price?",
    detail:
      "Headline scanning for earnings surprises, product news, or scandals the price may not have fully absorbed. Currently keyword-based — a known limitation, not a finished feature."
  },
  {
    name: "Alternative data",
    question: "What are insiders and the well-connected doing?",
    detail:
      "Insider buy/sell filings, congressional trade disclosures, short-selling pressure, and regulatory filings — summarized into brief notes rather than raw documents."
  },
  {
    name: "Bull vs. Bear debate",
    question: "Prove it is a bad idea.",
    detail:
      "A second AI prompt attacks the trade idea and finds every reason it will fail. The original case must answer the objections. Some objections also trigger hard veto rules that the AI cannot override."
  }
];

const SAFETY_RULES: string[] = [
  "Stocks only — no options, crypto, or other complex instruments.",
  "You pre-approve the entire universe of stocks the system may consider.",
  "Maximum $10 per order by default.",
  "Maximum $500 of total trading value per day.",
  "No single stock may exceed 25% of the portfolio.",
  "Maximum 10 real orders per day.",
  "A kill switch immediately blocks all new orders.",
  "System states: halted, close-only (exits only), or liquidating (sells only).",
  "Old proposals expire automatically so stale ideas cannot be acted on as if fresh.",
  "Short-selling has extra brakes; shorting requires explicit position approval.",
  "Two authority levels: LLM proposes only (you act) vs. LLM decides (acts within all limits above)."
];

const WEAKNESSES: Array<{ category: string; items: string[] }> = [
  {
    category: "About the AI itself",
    items: [
      "It can be confidently wrong. The bull/bear debate and safety rules reduce this but do not eliminate it.",
      "It can be inconsistent — ask the same question twice and the reasoning may differ.",
      "Its 'lessons learned' summaries are themselves AI-generated; a misleading lesson could nudge future decisions the wrong way."
    ]
  },
  {
    category: "About the data",
    items: [
      "Free-tier quotes may be delayed, not live. Smart-money feeds are rate-limited and frequently return nothing.",
      "The built-in S&P 500 list is a static snapshot captured on a specific date — it can drift out of date.",
      "Sentiment scoring is keyword-based, not a finance-specific language model. Upgrading it is a known to-do."
    ]
  },
  {
    category: "About the strategy logic",
    items: [
      "The factor weights (Fundamentals 30%, Macro 25%, Technicals 25%, Sentiment 20%) are educated guesses, not data-proven.",
      "There is no rigorous backtester. The strategy has not been tested against decades of historical data. This is a major limitation.",
      "Cold start: with fewer than 20 completed trades, the learning loop is barely learning. Early behavior reflects initial guesses.",
      "Overfitting risk: as it adapts to recent conditions it may get good at fighting the last war and be caught off guard by regime changes.",
      "Tiny $10 order sizes keep it safe, but at that scale trading costs and slippage dominate the P&L signal — results may not scale.",
      "Short selling is high-risk and not fully proven in this system. Accounting and broker behavior for short/cover trades need more verification before trusting with real money."
    ]
  },
  {
    category: "About the plumbing",
    items: [
      "Single local process: if the machine is off, nothing runs. Not distributed or highly available.",
      "No market-holiday calendar: the scheduler knows weekends and daily hours but may attempt a cycle on a holiday.",
      "Local SQLite database: one file on one machine — a documented backup path exists but is not automatic.",
      "Cost-saving context trimming: occasionally something useful gets cut from what the AI sees."
    ]
  },
  {
    category: "The bottom line",
    items: [
      "No edge is guaranteed. Markets are highly competitive. Assume this system has no proven edge until a long track record across varied conditions says otherwise.",
      "You can lose money in real mode. Safety rules cap how fast and how much, but they cannot make a losing strategy profitable."
    ]
  }
];

export default function StrategyPage() {
  if (process.env.LANDING_PAGE_ENABLED !== "true") notFound();

  return (
    <div className="min-h-screen bg-bg text-fg">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="border-b border-line bg-surface/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <span className="text-base font-semibold text-fg">Agentic Trading</span>
          <a href="/welcome" className={buttonClass({ variant: "primary", size: "sm" })}>
            Home
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-16 space-y-16">
        {/* ── Hero ───────────────────────────────────────────────────── */}
        <section className="space-y-5">
          <h1 className="text-3xl font-bold tracking-tight text-fg sm:text-4xl">
            How the strategy works
          </h1>
          <p className="text-lg text-muted leading-relaxed">
            An AI reads a lot of market data, argues with itself about whether a trade is a good
            idea, and only if it survives that argument does a set of hard-coded safety rules let a
            small order through — and the system keeps score so it can slowly get better.
          </p>
          <p className="text-sm text-faint">
            This page is an honest explanation, not a sales pitch. It includes real limitations and
            weaknesses.
          </p>
        </section>

        {/* ── What it does ───────────────────────────────────────────── */}
        <section className="space-y-5">
          <h2 className="text-xl font-semibold text-fg">What it does</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {CORE_LOOP.map((item) => (
              <Card key={item.title} className="p-5 space-y-2">
                <h3 className="text-sm font-semibold text-fg">{item.title}</h3>
                <p className="text-sm text-muted leading-relaxed">{item.body}</p>
              </Card>
            ))}
          </div>
        </section>

        {/* ── How it decides ─────────────────────────────────────────── */}
        <section className="space-y-6">
          <h2 className="text-xl font-semibold text-fg">How it decides</h2>
          <p className="text-sm text-muted leading-relaxed">
            Every candidate is evaluated through six independent research lenses. Each lens is scored
            0–100 and blended into an overall ranking using a weighting matrix (Fundamentals 30%,
            Macro 25%, Technicals 25%, Sentiment 20%). The AI sees those scores plus the underlying
            evidence and reasons on top of them. Neither the scores nor the AI replace the final
            safety gates.
          </p>
          <ol className="space-y-4">
            {SIX_LENSES.map((lens, i) => (
              <li key={lens.name} className="flex gap-4">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg text-sm font-bold">
                  {i + 1}
                </span>
                <div className="space-y-1 pt-1">
                  <p className="text-sm font-semibold text-fg">
                    {lens.name}{" "}
                    <span className="font-normal text-faint">— “{lens.question}”</span>
                  </p>
                  <p className="text-sm text-muted leading-relaxed">{lens.detail}</p>
                </div>
              </li>
            ))}
          </ol>
          <Card className="p-5 space-y-3">
            <h3 className="text-sm font-semibold text-fg">
              Deterministic safety rules (the AI cannot override these)
            </h3>
            <ul className="space-y-1.5">
              {SAFETY_RULES.map((rule) => (
                <li key={rule} className="flex gap-2 text-sm text-muted leading-relaxed">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span>{rule}</span>
                </li>
              ))}
            </ul>
          </Card>
        </section>

        {/* ── Learning loop ──────────────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold text-fg">The learning loop</h2>
          <p className="text-sm text-muted leading-relaxed">
            Every executed trade is recorded with the full market conditions at the time, a thesis
            tag (the type of trade — e.g. “Value Play” or “Breakout”), and the worst and best paper
            swing reached while it was open. The system later builds scorecards — which thesis types
            make money, in which market conditions — using a statistical technique that distrusts
            small samples until real evidence arrives. When enough data exists, it can <em>suggest</em>{" "}
            shifting the factor weights, but only a human can approve those changes in the dashboard.
            The “self-tuning” is currently more “self-advising.” With fewer than 20 completed trades
            the learning is barely learning — early behavior reflects the initial guesses, not earned
            wisdom.
          </p>
        </section>

        {/* ── Practice modes ─────────────────────────────────────────── */}
        <section className="space-y-4">
          <h2 className="text-xl font-semibold text-fg">Practice modes</h2>
          <p className="text-sm text-muted leading-relaxed">
            The system has three levels of exposure, each requiring a deliberate step up:
          </p>
          <ol className="space-y-3">
            <li className="flex gap-4">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface border border-line text-fg text-xs font-bold">
                1
              </span>
              <div className="pt-0.5 space-y-0.5">
                <p className="text-sm font-semibold text-fg">
                  Test — Local Sim <span className="font-normal text-faint">(default)</span>
                </p>
                <p className="text-sm text-muted leading-relaxed">
                  A built-in local simulator: simulated cash, simulated fills, real market data. No
                  broker connection required. Convenient for exploring the workflow, but it is a
                  simplified simulation — market impact, partial fills, and realistic slippage are
                  not modeled. Do not treat local-sim results as predictive of real performance.
                </p>
              </div>
            </li>
            <li className="flex gap-4">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface border border-line text-fg text-xs font-bold">
                2
              </span>
              <div className="pt-0.5 space-y-0.5">
                <p className="text-sm font-semibold text-fg">Paper — Connected Broker</p>
                <p className="text-sm text-muted leading-relaxed">
                  A practice account hosted by a real broker, such as Alpaca Paper Trading. Still
                  simulated money, but orders travel through a real broker&apos;s system and you see
                  realistic fills, latency, and market hours. This is likely{" "}
                  <strong>more realistic than the local simulator</strong> and is the recommended way
                  to rehearse before using real money.
                </p>
              </div>
            </li>
            <li className="flex gap-4">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface border border-line text-fg text-xs font-bold">
                3
              </span>
              <div className="pt-0.5 space-y-0.5">
                <p className="text-sm font-semibold text-fg">Brokerage — Real Money</p>
                <p className="text-sm text-muted leading-relaxed">
                  A real account with real money. Intentionally hard to reach and wrapped in every
                  limit described above. Treat this entire system as experimental before using it
                  with real capital.
                </p>
              </div>
            </li>
          </ol>
        </section>

        {/* ── Honest limitations ─────────────────────────────────────── */}
        <section className="space-y-5">
          <Card className="p-6 space-y-6 border-line-strong">
            <h2 className="text-base font-semibold text-fg">Honest limitations &amp; risks</h2>
            <p className="text-sm text-muted leading-relaxed">
              This section is the point of reading this page. Do not skip it.
            </p>
            {WEAKNESSES.map((group) => (
              <div key={group.category} className="space-y-2">
                <h3 className="text-sm font-semibold text-fg">{group.category}</h3>
                <ul className="space-y-1.5">
                  {group.items.map((item) => (
                    <li key={item} className="flex gap-2 text-sm text-muted leading-relaxed">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-line-strong" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Card>
        </section>

        {/* ── Disclosures ────────────────────────────────────────────── */}
        <section>
          <Card className="p-6 space-y-4 border-line-strong">
            <h2 className="text-base font-semibold text-fg">Important disclosures</h2>
            <p className="text-sm text-muted leading-relaxed">
              Agentic Trading is software for market research and strategy simulation. It is not
              investment advice, and it is not a broker-dealer or a registered investment adviser.
            </p>
            <p className="text-sm text-muted leading-relaxed">
              Trading and investing involve substantial risk of loss. Simulated or hypothetical
              performance has inherent limitations and is not a guarantee of future results. Nothing
              here is a recommendation to buy or sell any security.
            </p>
            <p className="text-sm text-muted leading-relaxed">
              You are solely responsible for your own investment decisions. Consult a licensed
              financial professional before trading.
            </p>
          </Card>
        </section>
      </main>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer className="border-t border-line mt-8">
        <div className="mx-auto max-w-3xl px-6 py-8 flex flex-col items-center gap-2 text-center sm:flex-row sm:justify-between">
          <p className="text-xs text-faint">
            Not investment advice. Trading involves risk of loss.{" "}
            <a href="/welcome" className="underline underline-offset-2 hover:text-muted">
              Home
            </a>
          </p>
          <p className="text-xs text-faint">
            &copy; 2026 Agentic Trading &middot;{" "}
            <a href="mailto:mail@jays.services" className="underline underline-offset-2 hover:text-muted">
              mail@jays.services
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
