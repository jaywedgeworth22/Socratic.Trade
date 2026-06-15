// Next.js instrumentation hook — runs once at server startup (Node.js runtime only).
// See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

export async function register() {
  // Only run in the Node.js server runtime; skip edge runtime and browser bundles.
  if (process.env.NEXT_RUNTIME !== "nodejs" || typeof window !== "undefined") return;

  const { startScheduler } = await import("./src/lib/scheduler");
  startScheduler();
}
