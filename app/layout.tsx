import "./globals.css";
import type { Metadata } from "next";
import { ThemeProvider, themeInitScript } from "./ui/theme";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  title: "Agentic Trading Cockpit",
  description: "Local dashboard for managing an agentic trading account"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ThemeProvider>
          {children}
          <Toaster theme="system" position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
