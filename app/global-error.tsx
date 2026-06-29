"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // No-op when Sentry was not initialized (NEXT_PUBLIC_SENTRY_DSN unset).
    Sentry.captureException(error);
  }, [error]);

  const message = error.message?.trim() || "The workspace failed to render.";
  return (
    <html lang="en">
      <body>
        <main
          style={{
            minHeight: "100dvh",
            display: "grid",
            placeItems: "center",
            padding: 24,
            background: "#f8fafc",
            color: "#111827",
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
          }}
        >
          <div style={{ maxWidth: 520, textAlign: "center" }}>
            <h1 style={{ fontSize: 24, lineHeight: 1.2, margin: "0 0 10px" }}>Dashboard error</h1>
            <p style={{ margin: "0 0 18px", color: "#475569" }}>
              {message}
            </p>
            {error.digest && (
              <p style={{ margin: "0 0 18px", color: "#64748b", fontSize: 13 }}>
                Reference: {error.digest}
              </p>
            )}
            <button
              type="button"
              onClick={reset}
              style={{
                border: "1px solid #111827",
                background: "#111827",
                color: "#fff",
                borderRadius: 6,
                padding: "10px 14px",
                font: "inherit",
                cursor: "pointer"
              }}
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
