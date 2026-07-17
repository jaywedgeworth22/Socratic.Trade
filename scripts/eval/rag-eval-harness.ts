import { getDb } from "../../src/lib/db";
import { retrieveFusedContext } from "../../src/lib/rag/search-fusion";

interface GoldenSetItem {
  id: string;
  query: string;
  expected_cik: string;
  expected_accession: string;
  expected_text_snippet: string;
  category: string;
}

export async function runEvaluationHarness() {
  const db = getDb();
  const items = db.prepare("SELECT * FROM sec_eval_golden_set").all() as GoldenSetItem[];

  if (items.length === 0) {
    console.log("Evaluation golden set is empty. Insert records first.");
    return { recallAt10: 0, recallAt50: 0, ndcg: 0, count: 0 };
  }

  let totalRecallAt10 = 0;
  let totalRecallAt50 = 0;
  let totalNdcg = 0;

  const categoryStats: Record<string, { count: number; recallAt10: number; recallAt50: number; ndcg: number }> = {};

  for (const item of items) {
    // Resolve symbol from CIK, skip if CIK has no matching task row
    const taskRow = db.prepare("SELECT symbol FROM sec_ingest_tasks WHERE cik = ? LIMIT 1").get(item.expected_cik) as any;
    if (!taskRow?.symbol) {
      console.warn(`[rag-eval] No task found for CIK ${item.expected_cik} (${item.category}: "${item.query.slice(0, 60)}...") — skipping`);
      continue;
    }
    const symbol = taskRow.symbol;

    // Retrieve top 50 fused context results
    const results = await retrieveFusedContext(item.query, symbol, 50);

    let rank = -1;
    for (let i = 0; i < results.length; i++) {
      const textMatches = results[i].text.toLowerCase().includes(item.expected_text_snippet.toLowerCase());
      const accMatches = results[i].accession === item.expected_accession;
      if (textMatches && accMatches) {
        rank = i + 1; // 1-indexed rank
        break;
      }
    }

    const recallAt10 = rank > 0 && rank <= 10 ? 1 : 0;
    const recallAt50 = rank > 0 && rank <= 50 ? 1 : 0;
    const ndcg = rank > 0 ? 1 / Math.log2(rank + 1) : 0;

    totalRecallAt10 += recallAt10;
    totalRecallAt50 += recallAt50;
    totalNdcg += ndcg;

    if (!categoryStats[item.category]) {
      categoryStats[item.category] = { count: 0, recallAt10: 0, recallAt50: 0, ndcg: 0 };
    }
    const cat = categoryStats[item.category];
    cat.count++;
    cat.recallAt10 += recallAt10;
    cat.recallAt50 += recallAt50;
    cat.ndcg += ndcg;
  }

  const count = items.length;
  const metrics = {
    recallAt10: totalRecallAt10 / count,
    recallAt50: totalRecallAt50 / count,
    ndcg: totalNdcg / count,
    count
  };

  console.log("\n================ RAG EVALUATION REPORT ================");
  console.log(`Evaluated ${count} Golden Set queries:\n`);
  console.log(`Global Recall@10: ${(metrics.recallAt10 * 100).toFixed(2)}%`);
  console.log(`Global Recall@50: ${(metrics.recallAt50 * 100).toFixed(2)}%`);
  console.log(`Global nDCG:      ${metrics.ndcg.toFixed(4)}\n`);

  console.log("Category Breakdown:");
  console.log("-------------------------------------------------------");
  console.log("Category        | Count | Recall@10 | Recall@50 | nDCG");
  console.log("-------------------------------------------------------");
  for (const [name, stats] of Object.entries(categoryStats)) {
    const c = stats.count;
    console.log(
      `${name.padEnd(15)} | ${String(c).padEnd(5)} | ${(stats.recallAt10 / c * 100).toFixed(1).padStart(8)}% | ${(stats.recallAt50 / c * 100).toFixed(1).padStart(8)}% | ${(stats.ndcg / c).toFixed(4).padStart(6)}`
    );
  }
  console.log("=======================================================\n");

  return metrics;
}

if (require.main === module) {
  runEvaluationHarness().catch(err => {
    console.error("Evaluation harness failed:", err);
    process.exit(1);
  });
}
