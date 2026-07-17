const fs = require("fs");
const file = "app/ui/llm-model-catalog.ts";
let content = fs.readFileSync(file, "utf8");

if (!content.includes('provider: "openrouter"')) {
  const openRouterGroup = `
  {
    provider: "openrouter",
    label: "OpenRouter",
    options: [
      { value: "openrouter/openai/gpt-4o", label: "OpenRouter GPT-4o", tier: "$$$" },
      { value: "openrouter/openai/gpt-4o-mini", label: "OpenRouter GPT-4o-mini", tier: "$" },
      { value: "openrouter/anthropic/claude-3.5-sonnet", label: "OpenRouter Claude 3.5 Sonnet", tier: "$$$" },
      { value: "openrouter/anthropic/claude-3-5-haiku", label: "OpenRouter Claude 3.5 Haiku", tier: "$" },
      { value: "openrouter/google/gemini-1.5-pro", label: "OpenRouter Gemini 1.5 Pro", tier: "$$$" },
      { value: "openrouter/google/gemini-1.5-flash", label: "OpenRouter Gemini 1.5 Flash", tier: "$" },
      { value: "openrouter/meta-llama/llama-3.1-70b-instruct", label: "OpenRouter Llama 3.1 70B", tier: "$$" },
      { value: "openrouter/meta-llama/llama-3.1-405b-instruct", label: "OpenRouter Llama 3.1 405B", tier: "$$$" }
    ]
  }
];`;
  content = content.replace("];\n\nexport const CURATED_LLM_MODEL_IDS", openRouterGroup + "\n\nexport const CURATED_LLM_MODEL_IDS");
  fs.writeFileSync(file, content, "utf8");
  console.log("Added OpenRouter group to catalog");
} else {
  console.log("OpenRouter group already exists");
}
