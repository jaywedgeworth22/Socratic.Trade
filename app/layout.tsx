import "./globals.css";
import type { Metadata } from "next";
import { ThemeProvider, themeInitScript } from "./ui/theme";

export const metadata: Metadata = {
  title: "Agentic Trading Cockpit",
  description: "Local dashboard for managing a Robinhood agentic trading account"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
