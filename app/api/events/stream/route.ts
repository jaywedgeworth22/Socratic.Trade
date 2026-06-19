import { subscribeDashboardEvents, type DashboardEvent } from "@/lib/events";

export const dynamic = "force-dynamic";
// Must run on the Node runtime so it shares the in-process event bus with the scheduler/strategy.
export const runtime = "nodejs";

// Server-Sent Events stream of dashboard-relevant events. The browser opens one EventSource
// here and refreshes /api/dashboard when an event arrives, instead of polling every 30s.
export async function GET(request: Request) {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // controller already closed — ignore.
        }
      };

      // Open the stream and signal readiness.
      send(": connected\n\n");
      send("event: ready\ndata: {}\n\n");

      unsubscribe = subscribeDashboardEvents((event: DashboardEvent) => {
        send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });

      // Heartbeat comment keeps the tunnel/proxy from dropping an idle connection.
      heartbeat = setInterval(() => send(": ping\n\n"), 25_000);

      const close = () => {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener("abort", close);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (unsubscribe) unsubscribe();
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    }
  });
}
