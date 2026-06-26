# Provider logos for the model picker

The Assistant model dropdown (`app/ui/model-picker.tsx`) loads a logo per provider from this folder:

| File | Provider |
|------|----------|
| `openai.svg` | OpenAI |
| `anthropic.svg` | Anthropic (Claude) |
| `xai.svg` | xAI (Grok) |
| `gemini.svg` | Google Gemini |
| `mistral.svg` | Mistral |
| `deepseek.svg` | DeepSeek |

Each logo renders on a white tile (so dark/transparent marks stay visible in any theme). If a file is
missing, the picker falls back to a colored initial chip — no error — so it works before the SVGs land.

Drop the brand SVGs in with exactly these filenames (lowercase, `.svg`) and the logos appear with no
code change.
