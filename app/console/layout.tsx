import "./console.css";
import type { Metadata, Viewport } from "next";
import { ConsoleShell } from "./components/shell";

export const metadata: Metadata = {
  title: {
    default: "Console",
    template: "%s · Console"
  },
  description: "Ground-up trading console: word-first money-reality, one-click stop, decision receipts."
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef1f6" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0e14" }
  ]
};

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
