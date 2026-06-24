import { startAlpacaNewsStream } from "./alpaca-news-stream";
import { startAlpacaTradeUpdatesStream } from "./alpaca-trade-updates-stream";
import { startCongressStream } from "../congress-stream";

// Start all enabled outbound streaming workers. Called once from instrumentation.register()
// (the persistent Node process). Each worker is individually opt-in and no-ops when its keys
// or enable flag are missing, so this is safe to call unconditionally.
export function startStreams(): void {
  startAlpacaNewsStream();
  startAlpacaTradeUpdatesStream();
  startCongressStream(); // SSE consumer of congress.trade (App A) — opt-in (CONGRESS_STREAM_ENABLED)
}
