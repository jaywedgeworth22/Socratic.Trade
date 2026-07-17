# Local JSON Healing for Strategy & Red Team

**Summary:** 
Replaced LLM-based response healing with a purely local, code-based healing utility using the `jsonrepair` package.

**Why:**
The previous attempt to repair malformed JSON payloads from the Strategy and Red Team LLMs used an unprompted, hardcoded fallback LLM call (`gemini-2.5-flash`). This violated the user's explicit preference that fallback models must strictly follow user settings (`llmFallbackModels`) and shouldn't be invoked silently for JSON syntax repair when deterministic code can do it faster and cheaper. A code-based JSON repair prevents fallback LLM calls entirely for syntax issues.

**Files Changed:**
- `package.json`, `package-lock.json`: Added `jsonrepair` dependency.
- `src/lib/response-healing.ts`: New file containing a purely local `healMalformedJson` utility.
- `src/lib/strategy.ts`: Updated catch block to use local healing instead of an LLM loop.
- `src/lib/red-team.ts`: Updated catch block to use local healing instead of an LLM loop.
- `test/response-healing.test.ts`: Added unit tests for deterministic JSON repair.

**Verification:**
- Ran `npm install jsonrepair`.
- Tested with `npm test test/response-healing.test.ts` (Passed).
- `npm test` passed locally.

**Follow-ups:**
- Monitor the success rate of local JSON healing in production.
