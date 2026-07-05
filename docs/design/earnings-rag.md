# Earnings RAG design

Date: 2026-07-03

Purpose: define how Socratic Trade should ingest earnings-related material without wasting Pinecone /
Voyage quota or turning LLM summaries into ungrounded trading facts.

## Recommendation

Use a three-layer model:

1. **Structured facts table** for numbers the strategy should compare and learn from.
2. **Raw evidence chunks** for source-grounded RAG retrieval.
3. **LLM-generated earnings brief** as a derived convenience layer, not the source of truth.

Do not only embed a one-paragraph LLM summary. That hides the data the agent must inspect later and
makes errors harder to trace. Do not embed full unfiltered transcripts repeatedly. That wastes quota
and buries the important deltas in boilerplate.

Current repo gap: `strategy.ts` already asks retrieval for `earnings-transcript`, but there is no
producer that writes `earnings-transcript` documents yet. Implement earnings ingestion as a new producer
instead of overloading the generic SEC filing body path.

## Source priority

Highest confidence:
- SEC 8-K Item 2.02 earnings release, including exhibit 99.1 when available.
- 10-Q / 10-K MD&A and financial statements after filing.
- Company investor-relations earnings release PDF/HTML when it matches the SEC exhibit.

Useful with source/licensing caveats:
- Earnings-call transcript prepared remarks.
- Earnings-call Q&A.
- Investor deck / supplemental slides.

Lower confidence / should not be primary:
- News summaries and analyst recaps.
- Social posts.
- LLM summaries from another system unless their source citations are recoverable.

## Structured fields to extract

Identity / timing:
- `event_id`
- `symbol`
- `company_name`
- `fiscal_period`
- `fiscal_year`
- `reported_at`
- `accepted_at`
- `source_url`
- `accession`
- `source_type` (`sec-8k-2.02`, `earnings-release`, `10-q`, `transcript`, `slides`)
- `source_refs` for every extracted fact

Headline actuals:
- revenue, revenue growth YoY, revenue growth QoQ
- GAAP EPS, adjusted EPS, EPS surprise if consensus is available
- gross margin, operating margin, net margin
- operating income, net income, free cash flow
- cash, debt, net cash/debt

Guidance:
- next-quarter revenue guide low/high/mid
- full-year revenue guide low/high/mid
- EPS guide low/high/mid
- margin guide
- capex guide
- whether guidance was raised, lowered, initiated, withdrawn, or reaffirmed

Segment and driver data:
- segment revenue/growth
- geography or product-line growth when material
- backlog, bookings, RPO, ARR, subscriber/customer count, units shipped, same-store sales, or other
  industry-specific operating KPIs

Language and risk:
- management explanation of beat/miss
- demand tone
- pricing/margin tone
- inventory/channel tone
- macro/FX/rates/consumer tone
- one-time items
- risk flags and litigation/regulatory flags

Trading features:
- post-report price reaction window
- volume reaction
- gap size
- volatility regime
- whether the report changed an existing thesis tag

## What to embed

Embed raw source chunks with metadata:
- earnings-release headline + financial tables
- guidance paragraph/table
- segment results
- MD&A paragraphs that explain drivers
- risk/uncertainty paragraphs
- prepared remarks by topic
- Q&A exchanges, chunked by analyst question + full answer
- the derived earnings brief, but only after it includes source links and row-level citations

Do not embed:
- legal boilerplate safe-harbor text except one small chunk if it contains unusually specific risk
- full tables with no surrounding labels
- duplicated press release text from both company IR and SEC exhibit when the content hash matches
- every transcript sentence as separate tiny chunks

## LLM summarization policy

Use an LLM summarizer when the source is long or semi-structured:
- transcript Q&A
- large press-release tables
- 10-Q MD&A
- investor deck text

Do not use the LLM as the only extractor for numeric facts. Numeric facts should come from deterministic
parsing first when possible, then the LLM can classify, reconcile, and explain.

Recommended tier:
- Normal path: a `gpt-5.4-mini`-class model with JSON/schema support.
- High-impact path: escalate to a stronger model (`gpt-5.4`/`gpt-5.5` class) only when the report is
  for a current holding, candidate proposal, large position-sizing decision, long transcript, or
  conflicting documents.
- Store the served model, prompt version, source chunk IDs, and extraction confidence.

## Summarizer prompt

System:

```text
You are an earnings-analysis extraction agent for Socratic Trade. Extract only facts supported by the
provided source text. Do not infer missing numbers. Do not use outside knowledge. Preserve uncertainty.
Return strict JSON matching the schema. Every non-empty claim must include source_chunk_ids.
```

User:

```text
Analyze this earnings source for trading decision support.

Company: {{company_name}}
Ticker: {{symbol}}
Source type: {{source_type}}
Accepted/published at: {{accepted_at}}
Fiscal period if known: {{fiscal_period}}

Source chunks:
{{chunks_with_ids}}

Return JSON:
{
  "symbol": "string",
  "event_id": "string",
  "period": "string|null",
  "reported_at": "string|null",
  "source_type": "string",
  "headline": {
    "summary": "string",
    "tone": "positive|mixed|negative|unclear",
    "source_chunk_ids": ["string"]
  },
  "actuals": [
    {
      "metric": "string",
      "value": "number|string|null",
      "unit": "usd|percent|shares|count|bps|text|null",
      "period": "string|null",
      "yoy_change": "number|null",
      "qoq_change": "number|null",
      "source_chunk_ids": ["string"],
      "confidence": "high|medium|low"
    }
  ],
  "guidance": [
    {
      "metric": "string",
      "range_low": "number|null",
      "range_high": "number|null",
      "midpoint": "number|null",
      "unit": "usd|percent|shares|count|bps|text|null",
      "period": "string|null",
      "change_vs_prior": "raised|lowered|reaffirmed|initiated|withdrawn|unclear",
      "source_chunk_ids": ["string"],
      "confidence": "high|medium|low"
    }
  ],
  "drivers": [
    {
      "topic": "string",
      "claim": "string",
      "impact": "bullish|bearish|mixed|neutral|unclear",
      "source_chunk_ids": ["string"]
    }
  ],
  "risks": [
    {
      "risk": "string",
      "severity": "high|medium|low|unclear",
      "source_chunk_ids": ["string"]
    }
  ],
  "questions_for_strategy": ["string"],
  "missing_or_ambiguous": ["string"]
}
```

## Safeguards

- Keep `accepted_at` / `published_at` metadata and always apply `asOf` filters in backtests.
- Content-hash every raw chunk and derived summary; never re-embed unchanged content.
- Store summary documents with `doc_type:"earnings-summary"` and raw source chunks with their true
  source doc types.
- Treat extracted numbers with `confidence:"low"` unless they are directly present in a table or
  deterministically parsed.
- Refuse to summarize if source chunks do not include source IDs.
- Never let a failed summarizer block raw chunk indexing.
- Keep a per-run cap on reports summarized and a daily WU cap before embedding.
- Benchmark retrieval on questions such as "what changed in guidance?", "why did margins move?", and
  "what risks did management emphasize?" before expanding the corpus.
