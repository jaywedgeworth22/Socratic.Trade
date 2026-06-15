import "./styles.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Robinhood Agentic Dashboard",
  description: "Local dashboard for managing a Robinhood agentic trading account"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
