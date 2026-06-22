import "./globals.css";
import type { Metadata, Viewport } from "next";
import { ThemeProvider, themeInitScript } from "./ui/theme";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://trading.jays.services"),
  title: {
    default: "Agentic Trading — AI market research & strategy cockpit",
    template: "%s · Agentic Trading"
  },
  description:
    "Agentic Trading is an AI-assisted cockpit for researching markets, testing strategies in a connected paper account (e.g. Alpaca Paper Trading), and running a transparent, risk-controlled trading workflow you stay in control of. Not investment advice.",
  applicationName: "Agentic Trading",
  keywords: [
    "AI trading research",
    "automated trading software",
    "paper trading software",
    "algorithmic trading dashboard",
    "stock market analysis tool"
  ],
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "Agentic Trading",
    url: "/",
    title: "Agentic Trading — AI market research & strategy cockpit",
    description:
      "AI-assisted cockpit for market research, paper trading via a connected broker (e.g. Alpaca Paper Trading), and a transparent, risk-controlled trading workflow. Not investment advice."
  },
  twitter: {
    card: "summary_large_image",
    title: "Agentic Trading — AI market research & strategy cockpit",
    description: "AI-assisted market research + paper trading via a connected broker. Not investment advice."
  },
  // Default = NOINDEX. Only allow indexing when explicitly opted in (the app is private by default).
  robots:
    process.env.NEXT_PUBLIC_ALLOW_INDEXING === "true"
      ? { index: true, follow: true }
      : { index: false, follow: false, nocache: true }
};

// viewport-fit=cover lets the page extend under the notch/home indicator; the
// safe-area-inset padding in globals.css then keeps content clear of them.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover"
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
