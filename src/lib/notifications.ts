import { audit, getPolicy, insertNotificationEvent } from "./db";
import type { NotificationEvent, NotificationEventType, TradingPolicy } from "./types";

type Fetcher = typeof fetch;

export async function sendNotification(
  input: {
    type: NotificationEventType;
    title: string;
    payload: unknown;
  },
  options: { policy?: TradingPolicy; fetcher?: Fetcher; timeoutMs?: number } = {}
): Promise<NotificationEvent> {
  const policy = options.policy ?? getPolicy();
  const settings = policy.notificationSettings;
  const webhookUrl = settings.webhookUrl?.trim();

  if (!settings.enabledEvents.includes(input.type)) {
    return record(input, "skipped", webhookUrl, "Notification type is disabled.");
  }

  if (!webhookUrl) {
    return record(input, "skipped", undefined, "Webhook URL is not configured.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);

  try {
    const response = await (options.fetcher ?? fetch)(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: input.type,
        title: input.title,
        payload: input.payload,
        createdAt: new Date().toISOString()
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) {
      return record(input, "failed", webhookUrl, `Webhook returned HTTP ${response.status}.`);
    }
    return record(input, "sent", webhookUrl);
  } catch (error) {
    clearTimeout(timeout);
    return record(input, "failed", webhookUrl, error instanceof Error ? error.message : "Webhook request failed.");
  }
}

function record(
  input: { type: NotificationEventType; title: string; payload: unknown },
  status: NotificationEvent["status"],
  webhookUrl?: string,
  error?: string
): NotificationEvent {
  const event = insertNotificationEvent({
    type: input.type,
    title: input.title,
    status,
    webhookUrl: webhookUrl ? maskWebhookUrl(webhookUrl) : undefined,
    payload: input.payload,
    error
  });
  audit("notification", event);
  return event;
}

function maskWebhookUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    return url.toString();
  } catch {
    return value;
  }
}
