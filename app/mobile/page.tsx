import type { Metadata } from "next";
import { MobilePwaClient } from "./mobile-pwa-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Mobile Control",
  description: "Phone-first control surface for Agentic Trading.",
  alternates: { canonical: "/mobile" }
};

export default function MobilePage() {
  return <MobilePwaClient />;
}
