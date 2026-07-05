# Manager / Strategist model options — cross-provider evaluation

Decision aid for the sovereign-design question **"which model tier + budget runs the
strategist ('Manager') loop?"** The owner asked for a cross-provider options list (not
Anthropic-only) and a way to evaluate how each performs — including DeepSeek for cost.

> **Pricing is as of July 2026 and moves often — re-verify at the provider's pricing page before
> committing a budget.** Anthropic figures are from the bundled `claude-api` model reference;
> others are from web search (sources at the bottom). $ = USD per **1M tokens** (input / output).

---

## 1. The candidates

| Provider | Model | $ in | $ out | Context | Reasoning | Wires into this repo via |
|---|---|---|---|---|---|---|
| **Anthropic** | Claude Opus 4.8 | 5 | 25 | 1M | adaptive | native Anthropic path (already in the assistant chat) |
| Anthropic | Claude Sonnet 5 | 3 (2 intro→08-31) | 15 (10 intro) | 1M | adaptive | native Anthropic path |
| Anthropic | Claude Haiku 4.5 | 1 | 5 | 200K | — | native Anthropic path |
| Anthropic | Claude Fable 5 | 10 | 50 | 1M | always-on | native Anthropic path (premium; likely overkill here) |
| **OpenAI** | GPT-5.5 | 5 | 30 | — | effort knob | **OpenAI path (default — this is what the loop uses today)** |
| OpenAI | GPT-5.4 | 2.50 | 15 | — | effort knob | OpenAI path |
| **Google** | Gemini 3.1 Pro | 2 | 12 | (200K tier) | thinking | OpenAI-compatible endpoint (base-URL swap) |
| Google | Gemini 3.5 Flash | 1.50 | 9 | — | thinking | OpenAI-compatible endpoint |
| Google | Gemini 3 Flash Preview | 0.50 | 3 | — | thinking | OpenAI-compatible endpoint |
| **DeepSeek** | V4 Pro | 1.74 (promo 0.44) | 3.48 (promo 0.87) | 1M | yes | OpenAI-compatible endpoint (base-URL swap) |
| DeepSeek | V4 Flash | 0.14 | 0.28 | 1M | — | OpenAI-compatible endpoint |
| **xAI** | Grok 4.3 | 1.25 | 2.50 | — | reasoning variant | OpenAI-compatible endpoint |
| xAI | Grok 4.1 Fast | 0.20 | 0.50 | — | reasoning variant | OpenAI-compatible endpoint |
| **Alibaba** | Qwen3.7-Max | 2.50 (promo 1.25) | 7.50 (promo 3.75) | — | `enable_thinking` | OpenAI-compatible endpoint |
| Alibaba | Qwen-Plus | 0.40 | 1.20 | — | `enable_thinking` | OpenAI-compatible endpoint |

**Wiring reality (important):** the strategist loop already speaks the **OpenAI Chat Completions**
shape (`OPENAI_API_KEY`), and the console assistant already has a native Anthropic path. DeepSeek,
xAI, Qwen, and Google all expose **OpenAI-compatible** endpoints — so adding any of them is a
`base_url` + key change and a model-id string, **not** a new integration per provider. That makes an
A/B across providers cheap to stand up.

## 2. Cost reality for THIS workload

The strategist is **low-volume and output-heavy**: a handful of runs per day, each producing a few
schema-constrained proposals plus reasoning. So **output tokens dominate**, and the absolute cost per
run is small even on a premium model. Rough per-run envelope (say ~15K input context + ~8K output
incl. reasoning):

| Model | ~$ / run | ~$ / month @ 20 runs/day |
|---|---|---|
| DeepSeek V4 Flash | ~$0.004 | ~$2.5 |
| Grok 4.1 Fast | ~$0.007 | ~$4 |
| Gemini 3 Flash Preview | ~$0.03 | ~$18 |
| DeepSeek V4 Pro (promo) | ~$0.014 | ~$8 |
| Gemini 3.1 Pro | ~$0.13 | ~$78 |
| Claude Sonnet 5 (intro) | ~$0.11 | ~$66 |
| GPT-5.5 | ~$0.32 | ~$190 |
| Claude Opus 4.8 | ~$0.28 | ~$168 |

Takeaway: at this run frequency, **even the most expensive option is ~$150–200/mo**, and the cheapest
are a few dollars. The cost spread is real but the absolute numbers are low — for a role that decides
real-money trades, **capability and reliability should outweigh token cost**. Cost matters more if you
later crank run frequency, add per-account fan-out, or move to high-frequency scanning.

## 3. What actually matters for the strategist role

Not raw benchmark IQ — the things that make a trading strategist safe and usable:

1. **Structured-output / JSON-schema adherence.** Proposals are schema-constrained (`TradeProposal`
   with required `tradeThesisTag`, `entryMarketRegime`, side, sizing…). A model that reliably emits
   valid, complete structured output matters more than one that's 2 points higher on a reasoning eval.
   Anthropic (strict tool use / `output_config.format`) and OpenAI (structured outputs) are the most
   battle-tested here; DeepSeek/Qwen/Grok/Gemini via the OpenAI-compatible path are usually fine but
   should be verified on the actual schema.
2. **Reasoning quality on ambiguous, incomplete market data** — the core judgment call.
3. **Instruction-following / not over-trading** — respecting the "only propose with genuine
   conviction" guidance and the guardrails framing.
4. **Refusal / policy behavior.** Some models refuse finance-adjacent prompts unevenly; the strategist
   prompt is benign but worth checking a model doesn't balk.
5. **Data handling / ToS.** Confirm each provider's terms permit automated trading-assistance use and
   that data-residency/retention fits your posture (esp. non-US providers: DeepSeek, Qwen).

## 4. Recommendation

**Don't pick by spec sheet — measure it.** #334 just landed **`proposedByModel` persistence**, so the
app now records realized win-rate / return / P&L **per model** on Results. That turns "evaluate how
each performs" from a guess into an experiment:

1. **Shortlist 3 to A/B** (spans the capability/cost space):
   - **Claude Sonnet 5** — strong reasoning + best-in-class structured output, ~$0.11/run at intro
     pricing. The balanced default.
   - **DeepSeek V4 Pro** — the cost play the owner flagged; frontier-ish reasoning at ~$0.01/run.
     Verify schema adherence + ToS/data-residency first.
   - **GPT-5.5 or Gemini 3.1 Pro** — a third independent lineage so you're not comparing two similar
     models; pick by whichever you trust more on structured output.
2. **Run all three in paper mode** over the same universe/period (rotate the strategist model per run
   or per account), and let the **Results page's per-model breakdown** rank them on *realized* outcomes
   — the only metric that matters for a trader.
3. **Promote the winner** to the live Manager role; keep a cheaper model (DeepSeek V4 Flash / Grok 4.1
   Fast) as the scout/pre-filter tier if you add a two-stage loop later.

**If you want a single default today without the A/B:** **Claude Sonnet 5** — best balance of reasoning,
structured-output reliability, and cost for this role, and it's already wired natively. Reserve
**Opus 4.8 / Fable 5** for if the soak shows the strategist is under-reasoning on hard setups (they cost
more per run but the absolute monthly delta is small at this volume).

**Budget to set:** at 20 runs/day, **$25–200/mo** covers any single-model choice; **$300/mo** comfortably
covers a 3-model A/B plus headroom. Set the ceiling where you're comfortable and the frequency/tier can
scale into it.

## 5. Wiring notes

- **OpenAI-compatible providers (DeepSeek, xAI, Qwen, Google):** point the existing OpenAI client at the
  provider's `base_url`, set that provider's key, use its model-id string. No per-provider SDK.
  - DeepSeek: `https://api.deepseek.com` · Grok: `https://api.x.ai/v1` · Gemini:
    `https://generativelanguage.googleapis.com/v1beta/openai/` · Qwen (intl):
    `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`.
- **Anthropic:** native path already exists in the console assistant; reuse it for the strategist.
- **Structured output:** validate the `TradeProposal` schema round-trips on each candidate before
  trusting it in a run — providers vary in JSON-schema strictness.
- Keep the model choice a **policy/setting** (per the existing model-picker surface) so the A/B is a
  config change, not a code change, and `proposedByModel` stamps each run correctly.

## 6. Caveats
- **Pricing/models change monthly** — re-verify before committing (sources below).
- **Reasoning tokens bill as output** on every provider here — a reasoning model's real per-run cost is
  higher than its sticker if it thinks a lot; the envelope in §2 already assumes reasoning output.
- **Non-US providers (DeepSeek, Qwen):** confirm ToS permits this use and that data handling fits your
  requirements before sending real portfolio context.

---

### Sources (July 2026)
- Anthropic: bundled `claude-api` model reference (Opus 4.8 $5/$25, Sonnet 5 $3/$15 intro $2/$10, Haiku 4.5 $1/$5, Fable 5 $10/$50).
- DeepSeek: [api-docs.deepseek.com/quick_start/pricing](https://api-docs.deepseek.com/quick_start/pricing)
- OpenAI: [developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing)
- Google Gemini: [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing)
- xAI Grok: [x.ai/api](https://x.ai/api)
- Alibaba Qwen: [alibabacloud.com/help/en/model-studio/billing-for-model-studio](https://www.alibabacloud.com/help/en/model-studio/billing-for-model-studio)
