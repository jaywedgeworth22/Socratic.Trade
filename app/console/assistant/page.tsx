import type { Metadata } from "next";
import { AssistantChat } from "./chat";

export const metadata: Metadata = {
  title: "Assistant",
  description: "Chat with the trading copilot. It answers with live data and drafts orders that go through Approvals — it never places one itself."
};

export default function AssistantPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <AssistantChat />
    </div>
  );
}
