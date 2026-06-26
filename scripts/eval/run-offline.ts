/**
 * Offline eval runner — replays the seed dataset through the LLM provider abstraction.
 *
 * DEFAULT MODE (no env vars required):
 *   Runs every eval case through MockLLM only. No network, no API keys.
 *   npx tsx scripts/eval/run-offline.ts
 *
 * REAL-PROVIDER MODE (opt-in via EVAL_REAL_PROVIDERS=1):
 *   Additionally runs cases through every provider whose API key is set in the environment.
 *   Requires the corresponding env var (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.).
 *   npx tsx scripts/eval/run-offline.ts --real-providers
 *   or: EVAL_REAL_PROVIDERS=1 npx tsx scripts/eval/run-offline.ts
 *
 * LANGFUSE (opt-in via LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY):
 *   Each run + score is logged to Langfuse when both keys are set.
 *   Reuses the existing withLlmGeneration wrapper — no-op when not configured.
 *
 * BASELINE threshold (default 0.75):
 *   Override with EVAL_PASS_THRESHOLD=0.8 (0.0–1.0).
 *   Runner exits with code 1 when the aggregate score falls below the threshold.
 */

// ── DB bootstrap (must precede any import that lazily calls getDb) ─────────────
// llm.ts → resolveLlmCredential → getDb(); set DATABASE_URL before the imports resolve.
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `eval-runner-${Date.now()}.db`)}`;
}

// ── Imports ───────────────────────────────────────────────────────────────────
import { getDb } from "../../src/lib/db";
import { MockLLM, llmForModel, chatProviderForModel } from "../../src/lib/chat/llm";
import type { ChatLLM, LlmRunArgs } from "../../src/lib/chat/types";
import { SYSTEM_PROMPT } from "../../src/lib/chat/prompt";
import { withLlmGeneration } from "../../src/lib/observability";
import { DATASET } from "./dataset";
import { scoreCase, scoreLlmJudge } from "./score";
import type { CaseScore } from "./score";

// ── DB init ───────────────────────────────────────────────────────────────────
getDb();

// ── Config ────────────────────────────────────────────────────────────────────
const PASS_THRESHOLD = Number(process.env.EVAL_PASS_THRESHOLD ?? 0.75);
const USE_REAL_PROVIDERS = process.env.EVAL_REAL_PROVIDERS === "1" || process.argv.includes("--real-providers");
const USE_JUDGE = Boolean(process.env.EVAL_JUDGE_API_KEY && process.env.EVAL_JUDGE_MODEL);
const SESSION_ID = `eval-offline-${Date.now()}`;

// ── Tool stubs ────────────────────────────────────────────────────────────────
// Read-only stubs; nothing executes, no money path.
async function executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "get_quote":
      return { symbol: input.symbol, price_usd: 200, change_pct: 1.2, as_of: "2026-01-15T00:00:00Z", source: "stub", session: "regular" };
    case "create_alert":
      return { symbol: input.symbol, op: input.op, price: input.price };
    case "draft_order":
      return {
        draft_id: "draft-stub-001",
        symbol: input.symbol,
        side: input.side,
        qty: input.qty,
        order_type: input.order_type,
        limit_usd: input.limit_usd ?? null,
        rationale: input.rationale ?? "",
        account_label: "Eval Stub (paper)",
        is_real: false,
        blocked: false,
        warnings: [],
        executed: false as const,
      };
    case "kb_search": {
      const query = String(input.query ?? "").toLowerCase();
      const ticker = String(input.ticker ?? "");
      if (ticker === "AAPL" && /supply/.test(query)) {
        return {
          chunks: [
            {
              chunk_id: "AAPL-10K#c001",
              text: "Apple faces supply-chain and supplier-concentration risks that could affect revenue timing.",
              source: "sec",
              as_of: "2024-01-15",
            },
          ],
        };
      }
      return { chunks: [] };
    }
    case "watchlist_add":
      return { item: { symbol: input.symbol, deduped: false } };
    case "get_positions":
      return { positions: [] };
    case "get_portfolio":
      return { portfolio: { totalMarketValue: 10000, cash: 10000 } };
    case "list_watchlist":
      return { watchlist: [] };
    case "list_alerts":
      return { alerts: [] };
    default:
      return { error: `unknown tool: ${name}` };
  }
}

// ── Build LLM args for a case ─────────────────────────────────────────────────
function buildArgs(message: string): LlmRunArgs {
  return {
    system: SYSTEM_PROMPT,
    message,
    tools: [],
    executeTool: executeTool as LlmRunArgs["executeTool"],
  };
}

// ── Run one case through one LLM ─────────────────────────────────────────────
interface RunResult {
  caseId: string;
  provider: string;
  output: string;
  caseScore: CaseScore;
  judgeScore?: { pass: boolean; score: number; detail: string };
  durationMs: number;
  error?: string;
}

async function runOneCase(llm: ChatLLM, evalCase: (typeof DATASET)[0], provider: string): Promise<RunResult> {
  const start = Date.now();
  const args = buildArgs(evalCase.input);

  let output = "";
  let error: string | undefined;

  try {
    const result = await withLlmGeneration(
      {
        name: `eval:${evalCase.id}`,
        model: llm.modelName ?? provider,
        sessionId: SESSION_ID,
        input: { message: evalCase.input },
        tags: ["eval", "offline", evalCase.task],
        metadata: { caseId: evalCase.id, provider, task: evalCase.task },
        output: (r: { text: string }) => ({ text: r.text }),
      },
      () => llm.run(args)
    );
    output = result.text;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    output = "";
  }

  const caseScore = scoreCase(evalCase.id, output, evalCase.expectations);

  let judgeScore: RunResult["judgeScore"];
  if (USE_JUDGE && evalCase.rubric && !error) {
    judgeScore = await scoreLlmJudge(output, evalCase.rubric, evalCase.id);
  }

  return {
    caseId: evalCase.id,
    provider,
    output,
    caseScore,
    judgeScore,
    durationMs: Date.now() - start,
    error,
  };
}

// ── Provider list for real-provider mode ──────────────────────────────────────
const PROVIDER_MODELS: Array<{ provider: string; model: string; envKey: string }> = [
  { provider: "openai", model: "gpt-4o-mini", envKey: "OPENAI_API_KEY" },
  { provider: "anthropic", model: "claude-haiku-4-5", envKey: "ANTHROPIC_API_KEY" },
  { provider: "xai", model: "grok-4.3", envKey: "XAI_API_KEY" },
  { provider: "gemini", model: "gemini-2.5-flash", envKey: "GEMINI_API_KEY" },
  { provider: "mistral", model: "ministral-3b-latest", envKey: "MISTRAL_API_KEY" },
  { provider: "deepseek", model: "deepseek-chat", envKey: "DEEPSEEK_API_KEY" },
];

// ── Summary table ─────────────────────────────────────────────────────────────
function printSummaryTable(results: RunResult[]): void {
  const byProvider = new Map<string, RunResult[]>();
  for (const r of results) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, []);
    byProvider.get(r.provider)!.push(r);
  }

  console.log("\n══ Eval Summary ══════════════════════════════════════════════\n");
  console.log(
    `${"PROVIDER".padEnd(14)} ${"PASS".padStart(5)} ${"FAIL".padStart(5)} ${"SCORE".padStart(7)} ${"AVG_MS".padStart(8)}`
  );
  console.log("─".repeat(44));

  for (const [provider, pResults] of byProvider) {
    const pass = pResults.filter((r) => r.caseScore.pass).length;
    const fail = pResults.length - pass;
    const avgScore = pResults.reduce((s, r) => s + r.caseScore.score, 0) / pResults.length;
    const avgMs = Math.round(pResults.reduce((s, r) => s + r.durationMs, 0) / pResults.length);
    console.log(
      `${provider.padEnd(14)} ${String(pass).padStart(5)} ${String(fail).padStart(5)} ${(avgScore * 100).toFixed(1).padStart(6)}% ${String(avgMs).padStart(7)}ms`
    );
  }

  console.log("\n── Per-case failures ────────────────────────────────────────\n");
  const failures = results.filter((r) => !r.caseScore.pass || r.error);
  if (failures.length === 0) {
    console.log("  (none)\n");
  } else {
    for (const r of failures) {
      console.log(`  [${r.provider}] ${r.caseId}${r.error ? ` ERROR: ${r.error}` : ""}`);
      for (const ch of r.caseScore.checks.filter((c) => !c.pass)) {
        console.log(`    ✗ ${ch.type}: ${ch.detail}`);
      }
      if (r.judgeScore && !r.judgeScore.pass) {
        console.log(`    ✗ judge: ${r.judgeScore.detail}`);
      }
    }
    console.log();
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n▶ Eval runner  session=${SESSION_ID}`);
  console.log(`  dataset size: ${DATASET.length} cases`);
  console.log(`  pass threshold: ${(PASS_THRESHOLD * 100).toFixed(0)}%`);
  console.log(`  real providers: ${USE_REAL_PROVIDERS ? "YES (opt-in)" : "no (mock only)"}`);
  console.log(`  llm judge: ${USE_JUDGE ? "YES" : "no"}\n`);

  const allResults: RunResult[] = [];

  // ── MockLLM (always runs) ──────────────────────────────────────────────────
  const mock = new MockLLM();
  console.log(`Running ${DATASET.length} cases against mock...`);
  for (const evalCase of DATASET) {
    const r = await runOneCase(mock, evalCase, "mock");
    allResults.push(r);
    const icon = r.caseScore.pass ? "✓" : "✗";
    process.stdout.write(`  ${icon} ${evalCase.id}\n`);
  }

  // ── Real providers (opt-in) ────────────────────────────────────────────────
  if (USE_REAL_PROVIDERS) {
    for (const { provider, model, envKey } of PROVIDER_MODELS) {
      const key = process.env[envKey];
      if (!key) {
        console.log(`\nSkipping ${provider} (${envKey} not set)`);
        continue;
      }
      console.log(`\nRunning ${DATASET.length} cases against ${provider} (${model})...`);
      // llmForModel resolves credentials from env/DB; with EVAL_REAL_PROVIDERS=1 and a key set,
      // it will return the real LLM. We force the env key so the DB lookup also sees it.
      process.env[envKey] = key;
      // Also set the provider-specific operator key env var that resolveLlmCredential reads.
      const providerEnvKey = `${provider.toUpperCase()}_API_KEY`;
      if (providerEnvKey !== envKey) process.env[providerEnvKey] = key;

      // chatProviderForModel confirms the model routes to the right provider.
      const detectedProvider = chatProviderForModel(model);
      if (detectedProvider !== provider) {
        console.warn(`  WARNING: model "${model}" routes to "${detectedProvider}", expected "${provider}" — skipping`);
        continue;
      }

      const llm = llmForModel(model);
      // If key resolution failed (DB / resolveLlmCredential), llmForModel returns MockLLM.
      if (llm.modelName === "mock") {
        console.log(`  Skipping ${provider}: key present in env but llmForModel returned mock (DB resolution issue)`);
        continue;
      }

      for (const evalCase of DATASET) {
        const r = await runOneCase(llm, evalCase, provider);
        allResults.push(r);
        const icon = r.caseScore.pass ? "✓" : "✗";
        process.stdout.write(`  ${icon} ${evalCase.id}\n`);
      }
    }
  }

  printSummaryTable(allResults);

  // ── Threshold check ────────────────────────────────────────────────────────
  const overallScore = allResults.reduce((s, r) => s + r.caseScore.score, 0) / allResults.length;
  const overallPass = allResults.filter((r) => r.caseScore.pass).length;
  const overallFail = allResults.length - overallPass;

  console.log(`══ Overall  pass=${overallPass}/${allResults.length}  score=${(overallScore * 100).toFixed(1)}%  threshold=${(PASS_THRESHOLD * 100).toFixed(0)}% ══\n`);

  if (overallScore < PASS_THRESHOLD) {
    console.error(`FAIL: overall score ${(overallScore * 100).toFixed(1)}% is below threshold ${(PASS_THRESHOLD * 100).toFixed(0)}%`);
    process.exit(1);
  }

  if (overallFail > 0) {
    console.warn(`WARNING: ${overallFail} case(s) failed but overall score is above threshold.`);
  }

  console.log("PASS");
}

main().catch((e) => {
  console.error("Eval runner crashed:", e instanceof Error ? e.message : String(e));
  process.exit(2);
});
