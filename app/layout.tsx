import "./globals.css";
import type { Metadata, Viewport } from "next";
import { ThemeProvider, themeInitScript } from "./ui/theme";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  title: "Agentic Trading Cockpit",
  description: "Local dashboard for managing an agentic trading account"
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
