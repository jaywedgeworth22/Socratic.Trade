// Server-only content for the /framework page.
//
// IMPORTANT: this module must never be imported from a client component. The
// framework prose is deliberately kept out of the HTML document and out of
// every client JS chunk — it is delivered only through the gated content API
// (app/api/framework/content/route.ts) to clients that pass the browser
// checks. Source of truth for the long-form version: docs/trading-framework.md.

export type TitledItem = { title: string; body: string };
export type DiagramNode = { lines: [string, string]; tone?: "pos" | "neg" };

export type FrameworkContent = {
  kicker: string;
  title: string;
  intro: string[];
  pipelineDiagram: DiagramNode[];
  pipeline: TitledItem[];
  principles: TitledItem[];
  layersHeading: string;
  layersIntro: string;
  layers: { name: string; body: string }[];
  decisionCoreIntro: string;
  decisionCore: TitledItem[];
  flywheelNodes: DiagramNode[];
  flywheelCenter: [string, string];
  learningIntro: string;
  learningLanes: TitledItem[];
  autonomyIntro: string;
  autonomy: TitledItem[];
  invariantsIntro: string;
  invariants: string[];
  limitsIntro: string;
  limits: TitledItem[];
  disclosures: string[];
  humanOnlyNote: string;
};

export const FRAMEWORK_CONTENT: FrameworkContent = {
  kicker: "Trading framework",
  title: "How market data becomes an accountable trading decision",
  intro: [
    "Socratic Trade is organized as a dialectic: one model argues for a trade, a second model argues against it, and deterministic code — never a model — controls sizing, risk gates, and order placement. The name is the method: every position must survive questioning before it exists, and every outcome is examined afterward so the framework itself improves.",
    "This page describes the framework, not any particular account: the pipeline every strategy run flows through, the safety architecture around it, and the learning loop that closes it."
  ],
  pipelineDiagram: [
    { lines: ["Observe", "the market"] },
    { lines: ["Assemble", "evidence"] },
    { lines: ["Green Team", "proposes"], tone: "pos" },
    { lines: ["Code sizes", "the trade"] },
    { lines: ["Red Team", "challenges"], tone: "neg" },
    { lines: ["Policy gate", "decides"] },
    { lines: ["Broker", "executes"] },
    { lines: ["Account", "and learn"] }
  ],
  pipeline: [
    {
      title: "1 · Observe",
      body: "Scan a configured symbol universe from a broad delayed screener plus dynamic index membership. Rank every name on eight factors — liquidity, momentum, value, quality, volatility, sentiment, positioning, diversification — then enrich top candidates through a cascading multi-provider data layer where every field records which source supplied it. Real data or an honest blank; the framework never fabricates a number."
    },
    {
      title: "2 · Assemble evidence",
      body: "Build a structured evidence bundle: macro data with a deterministic market-regime label, market internals, technicals, SEC-filing retrieval, congressional and insider signals, episodic memory of similar past decisions (counterexamples included, not curated out), the account's own realized scorecards, and tax context. Untrusted text is fenced as data, never commands."
    },
    {
      title: "3 · Green Team proposes",
      body: "An explicitly chosen proposer model returns schema-constrained trade proposals: symbol, side, a thesis tag from a fixed playbook, a confidence score, rationale, and invalidation levels. Proposing nothing is an explicitly legitimate outcome — inaction is measured, not hidden."
    },
    {
      title: "4 · Code sizes the trade",
      body: "Deterministic code — not the model — sizes every opening from realized per-thesis statistics: shrunk win rates, capped and calibrated conviction, reduce-only Kelly, volatility and portfolio-heat tapers. Thin evidence pins size to an exploratory floor; proven losers get zero."
    },
    {
      title: "5 · Red Team challenges",
      body: "A second, separately chosen model adversarially reviews every risk-adding opening at its final size, fact-checking the rationale against the same evidence the proposer saw. Its verdict is down-only: approve, approve at half size, or reject. If the reviewer cannot run for any reason, the trade fails closed to human approval. Exits are structurally exempt — dissent can never block de-risking."
    },
    {
      title: "6 · Policy gate decides",
      body: "A deterministic policy engine evaluates the sized, reviewed proposal against configured rules: exposure, notional, and concentration caps; order-type, drift, and staleness checks; wash-sale and short-sale handling. Only physical, broker, regulatory, and accounting impossibilities are hard blocks — everything else is an adjustable preference with a logged override path."
    },
    {
      title: "7 · Broker executes",
      body: "Approved orders route through one guarded choke point into a broker-agnostic gateway. Placement is crash-safe and idempotent: intent is persisted before the broker call, uncertain outcomes reconcile against broker truth, and protective stops rest at the broker so they survive app downtime. Paper vs. live is purely a property of the connected account — there is no simulation mode."
    },
    {
      title: "8 · Account and learn",
      body: "Fills are event-sourced and replayed into P&L, scorecards, and confidence calibration. Skipped and vetoed candidates become counterfactuals, closed trades feed episodic memory and post-mortems, and a statistically gated tuner may adjust factor weights — every learning mutation ledgered, revertible, and audited."
    }
  ],
  principles: [
    {
      title: "The model proposes, code disposes",
      body: "Models generate ideas and critiques. Deterministic code owns sizing, gating, placement, and accounting — and a regression test proves advisory context can never reach the sizing math."
    },
    {
      title: "Fail-open for data, fail-closed for money",
      body: "A missing quote degrades to a dash and the scan continues. A missing reviewer, credential, or model halts auto-execution and routes to a human. A wrong-but-plausible decision is worse than no decision."
    },
    {
      title: "Advisory guardrails, hard boundaries",
      body: "Risk rules advise, log, and escalate; they are adjustable preferences, not cages. The hard blocks are reserved for account isolation and physical, broker, regulatory, or accounting impossibility."
    },
    {
      title: "Never fabricate",
      body: "No synthetic data tier exists. Benchmarks return nothing rather than a guess, statistics are sample-gated, and outcomes that cannot be resolved stay in denominators with an explicit disclosure."
    },
    {
      title: "Dissent is structural",
      body: "Every risk-adding opening faces an adversarial review with evidence parity, and verdicts are down-only — dissent can shrink or block risk, never enlarge it. The reviewer's own value-add is measured with counterfactuals."
    },
    {
      title: "Everything leaves a receipt",
      body: "Every decision persists a case file with its evidence, verdicts, and overrides; every model call writes a usage-ledger row; every learning mutation lands in an append-only ledger with a single revert path."
    }
  ],
  layersHeading: "The layered architecture",
  layersIntro:
    "Each layer consumes the one above it and reports into the learning loop at the bottom, which feeds evidence back to the top. Failures degrade within a layer; they do not cascade.",
  layers: [
    {
      name: "Market observation",
      body: "Universe assembly, factor ranking, cascading enrichment with per-field provenance, macro/regime classification, technicals, market internals, and a computed trading calendar."
    },
    {
      name: "Evidence assembly",
      body: "Filing retrieval, alternative-data signals, episodic memory with counterexamples, realized scorecards, and tax context — fenced behind a data-not-command boundary."
    },
    {
      name: "Decision core",
      body: "Green Team proposes, deterministic code sizes, Red Team challenges, and a structured override path lets the agent argue past preference gates — on the record."
    },
    {
      name: "Policy gate",
      body: "One deterministic pre-trade gate over every proposal, with a closed list of hard blocks, escalation cards for self-healing failures, and exits that can never be trapped."
    },
    {
      name: "Execution",
      body: "A broker-agnostic gateway behind a single guarded choke point: idempotent placement, reconciliation against broker truth, and broker-held protective stops."
    },
    {
      name: "Accounting",
      body: "Event-sourced fills replayed into P&L and scorecards; paper fills cost-adjusted so learned edges survive live slippage; honest cash-flow-aware benchmarking."
    },
    {
      name: "Learning",
      body: "Post-mortems, counterfactuals, episodic memory, crossover safety gates, and statistically validated tuning — ledgered, clamped, revertible, and audited daily."
    }
  ],
  decisionCoreIntro:
    "The decision core is where the dialectic happens. Its roles are deliberately separated and its authority deliberately asymmetric.",
  decisionCore: [
    {
      title: "Green Team (the proposer)",
      body: "An explicitly chosen model receives the full evidence bundle and returns structured proposals under a strict schema. It runs deterministically, with a failover chain for transient provider failures. There are no default models — an unchosen seat fails closed with an actionable error, never a silent substitute."
    },
    {
      title: "Deterministic sizing",
      body: "Size comes from realized statistics, not model enthusiasm. Confidence can shrink a position freely but can only raise it past a cap when the thesis's own realized record corroborates it. Calibration remaps persistent overconfidence downward only."
    },
    {
      title: "Red Team (the adversary)",
      body: "A separately chosen model reviews every risk-adding opening at its final size — no conviction threshold, no exceptions. It fact-checks the rationale against the same evidence the proposer saw and critiques the exact sized order in the current regime. Down-only verdicts; any failure mode routes to a human, loudly."
    },
    {
      title: "The Socratic override",
      body: "The dialectic runs both ways: the agent may attach a structured override thesis to argue past preference gates — including a Red Team veto — stating what it believes, what conflicts it acknowledges, and what would prove it wrong. It resolves once, under an owner-configured mode, never bypasses hard gates, and every use is tagged and audited."
    }
  ],
  flywheelNodes: [
    { lines: ["Decisions", "and fills"] },
    { lines: ["Event-sourced", "accounting"] },
    { lines: ["Scorecards and", "calibration"] },
    { lines: ["Counterfactuals", "and memory"] },
    { lines: ["Validated", "tuning"] },
    { lines: ["Better", "evidence"], tone: "pos" }
  ],
  flywheelCenter: ["Ledgered, audited,", "revertible"],
  learningIntro:
    "Learning is a visible trail, not a vague claim. Five lanes run in parallel — all advisory by default, with exactly two tightly gated surfaces that can change behavior.",
  learningLanes: [
    {
      title: "Post-mortems",
      body: "Closed trades are reviewed with excursion timing — did winners get cut early, did losers get held through drawdowns? — and a bounded reflection feeds the next run's prompt."
    },
    {
      title: "Counterfactuals",
      body: "Every scored-but-skipped candidate and every vetoed proposal is tracked against what actually happened afterward, over trading-day horizons, against real prices only. Unresolvable rows stay in denominators, disclosed. The adversary's vetoes are scored the same way."
    },
    {
      title: "Episodic memory",
      body: "Closed trades are embedded — entry situation plus realized outcome — and recalled at decision time as advisory analogs, with opposite-outcome cases labeled as counterexamples rather than filtered out, and no lookahead."
    },
    {
      title: "Crossover safety",
      body: "Learned lessons pass a fail-closed risk classifier before they can influence anything. Facts flow as advisory context; anything touching risk needs human confirmation; conversational chat can never even queue a risk-tier lesson; and nothing learned can ever reach the sizing math."
    },
    {
      title: "Validated tuning",
      body: "Factor-weight changes must earn their way through an information-coefficient backtest with walk-forward out-of-sample validation. Autonomous application is off by default, clamped per step, scoped to scoring weights only, and every mutation lands in an append-only ledger with one revert path. A daily review board audits the lessons themselves for corruption by system defects."
    }
  ],
  autonomyIntro:
    "Autonomy is opt-in per account, explicit about authority, and engineered so that concurrency, crashes, and restarts fail toward safety.",
  autonomy: [
    {
      title: "Four entry points, one pipeline",
      body: "Scheduled cadence runs, event triggers (filings, regime flips, technical alerts — deduplicated and coalesced so a storm produces one run), manual run-once, and a chat assistant whose tools are read-only or draft-producing. All converge on the same run pipeline and proposal rail; a chat draft can only be promoted into the normal approval flow, never placed directly."
    },
    {
      title: "Authority is explicit",
      body: "Propose mode turns every proposal into a human approval card. Decide mode auto-executes — except for the fail-closed set: an unavailable reviewer, an unplaceable half-size verdict, or degraded reasoning quality all route to a human. Manual runs force propose mode, and cap breaches auto-demote authority back to ask-first."
    },
    {
      title: "One leader, one run per account",
      body: "Lease-based leader election ensures one scheduler per database; per-account single-flight locks ensure one run per broker account; and fencing checkpoints re-prove ownership before every irreversible step, so a run that loses its lease stops before placing another order."
    },
    {
      title: "Safety maintenance never starves",
      body: "Fill reconciliation, protective-stop monitoring, stale-order remediation, and proposal expiry run on every tick regardless of budgets or autonomy state. Spend ceilings only ever skip model work. And autonomy never resumes unattended after a restart — that requires an explicit opt-in."
    }
  ],
  invariantsIntro: "Invariants the framework enforces in code:",
  invariants: [
    "No connected broker account means no orders — there is no simulation fallback.",
    "Every risk-adding opening is adversarially reviewed or held for a human; reviewer failure fails closed.",
    "Verdicts and calibration are down-only: dissent and learning can shrink risk, never enlarge it.",
    "Sizing is deterministic and code-side; advisory or learned context cannot reach it.",
    "Exits are never trapped — not by universe rules, caps, budgets, staleness, or adversary outages.",
    "Nothing is fabricated: missing data renders blank, statistics are sample-gated, unresolved outcomes are disclosed.",
    "Placement is intent-first and idempotent; uncertain broker outcomes are reconciled, never guessed.",
    "Coordination failures fail closed: no proven lease, no money-path side effects.",
    "Every decision, verdict, override, and learning mutation leaves a durable, attributable receipt.",
    "Learning mutations are clamped, statistically gated, ledgered, and revertible."
  ],
  limitsIntro:
    "Kept per the framework's own rule: honest weaknesses stay listed until fixed, and fixed items move to a fixed list rather than being deleted.",
  limits: [
    {
      title: "The factor weights started as educated guesses",
      body: "The validation machinery exists to earn changes, but early samples are small and statistical shrinkage dominates."
    },
    {
      title: "Cold start is real",
      body: "Scorecards, calibration, and memory all need closed trades to say anything; a new account trades on floors and caps, not evidence."
    },
    {
      title: "Model judgment is the point — and the risk",
      body: "Structured outputs, evidence parity, adversarial review, and deterministic gates bound the blast radius, but a plausible-sounding thesis can still be wrong in ways no gate catches."
    },
    {
      title: "Free-tier data has gaps",
      body: "The cascade degrades honestly, but degraded is still degraded: thin fundamentals on small names, delayed base quotes, provider quotas on enrichment depth."
    },
    {
      title: "Counterfactuals measure price, not fills",
      body: "Skipped-candidate returns ignore the execution costs and liquidity constraints a real fill would have faced."
    }
  ],
  disclosures: [
    "Socratic Trade is software for market research, autonomous reasoning, and trade execution when connected to accounts you configure. It is not investment advice, a broker-dealer, or a registered investment adviser.",
    "Trading and investing involve substantial risk of loss. Simulated, hypothetical, or historical performance has inherent limitations and does not guarantee future results. Nothing here is a recommendation to buy or sell any security.",
    "You are responsible for your own investment decisions and for the authority you grant to any connected trading system."
  ],
  humanOnlyNote:
    "This page is provided for human readers in a browser. Automated access, scraping, text-and-data mining, and use of its content for AI training are not authorized."
};
