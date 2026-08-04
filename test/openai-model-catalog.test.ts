import { describe, expect, it } from "vitest";
import { modelDisplayName } from "../app/console/lib/models";
import { CHAT_MODEL_GROUPS, CURATED_LLM_MODEL_GROUPS } from "../app/ui/llm-model-catalog";
import { reasoningCapabilityForModel } from "../src/lib/llm-request";
import {
  reasoningAdviceForModel,
  recommendedReasoningEffortForModel
} from "../src/lib/model-reasoning-recommendations";

describe("curated OpenAI model choices across LLM surfaces", () => {
  const openAi = CURATED_LLM_MODEL_GROUPS.find((group) => group.provider === "openai")!;

  it("offers the three GPT-5.6 API tiers plus the genuinely cheaper Mini/Nano choices and GPT-4o", () => {
    expect(openAi.options.map((option) => option.value)).toEqual([
      "gpt-5.4-nano",
      "gpt-5.4-mini",
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "gpt-4o"
    ]);
    expect(openAi.options.find((option) => option.value === "gpt-5.6-terra")?.recommendedGreen).toBe(true);
    expect(openAi.options.find((option) => option.value === "gpt-5.6-sol")?.recommendedRed).toBe(true);
    expect(openAi.options.some((option) => option.value === "gpt-5.4" || option.value === "openai/gpt-5.5")).toBe(false);
  });

  it("shares the exact curated OpenAI options with Coach/chat", () => {
    expect(CHAT_MODEL_GROUPS.find((group) => group.provider === "openai")?.options).toEqual(openAi.options);
  });

  it("has a visible reasoning control and role-specific recommendation for every curated OpenAI option", () => {
    for (const option of openAi.options.filter((o) => o.value !== "gpt-4o")) {
      expect(reasoningCapabilityForModel(option.value)).toBeDefined();
      expect(recommendedReasoningEffortForModel(option.value, "green")).toBeTruthy();
      expect(recommendedReasoningEffortForModel(option.value, "red")).toBeTruthy();
      expect(recommendedReasoningEffortForModel(option.value, "chat")).toBeTruthy();
      expect(recommendedReasoningEffortForModel(option.value, "review")).toBeTruthy();
      expect(modelDisplayName(option.value)).toMatch(/^GPT/);
    }
  });


  it("pins the intended role/effort guidance for GPT-5.6", () => {
    expect(recommendedReasoningEffortForModel("gpt-5.6-luna", "chat")).toBe("low");
    expect(recommendedReasoningEffortForModel("gpt-5.6-luna", "green")).toBe("medium");
    expect(recommendedReasoningEffortForModel("gpt-5.6-terra", "green")).toBe("medium");
    expect(recommendedReasoningEffortForModel("gpt-5.6-terra", "red")).toBe("high");
    expect(recommendedReasoningEffortForModel("gpt-5.6-sol", "red")).toBe("high");
    expect(recommendedReasoningEffortForModel("gpt-5.6-sol", "review")).toBe("high");
  });
});
