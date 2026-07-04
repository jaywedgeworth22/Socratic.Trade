import { LlmUsageClient } from "../../admin/llm-usage/llm-usage-client";

export default function ConsoleUsagePage() {
  return <LlmUsageClient endpoint="/api/llm-usage" scope="user" />;
}
