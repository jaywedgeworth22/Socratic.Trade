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

  const isDiscord = webhookUrl.includes("discord.com/api/webhooks") || webhookUrl.includes("discordapp.com/api/webhooks");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);

  try {
    const payloadBody = isDiscord
      ? formatDiscordPayload(input)
      : {
          type: input.type,
          title: input.title,
          payload: input.payload,
          createdAt: new Date().toISOString()
        };

    const response = await (options.fetcher ?? fetch)(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payloadBody),
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

function formatDiscordPayload(input: {
  type: NotificationEventType;
  title: string;
  payload: any;
}) {
  const { type, title, payload } = input;
  let color = 10038562; // Default dark red
  let description = "";
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

  switch (type) {
    case "fill": {
      color = 3066993; // Green
      const fill = payload?.fill;
      if (fill) {
        fields.push(
          { name: "Symbol", value: String(fill.symbol), inline: true },
          { name: "Side", value: String(fill.side).toUpperCase(), inline: true },
          { name: "Status", value: String(fill.status), inline: true },
          { name: "Quantity", value: String(fill.quantity), inline: true },
          { name: "Price", value: `$${Number(fill.price).toFixed(2)}`, inline: true },
          { name: "Notional", value: `$${Number(fill.notional).toFixed(2)}`, inline: true }
        );
      }
      if (payload?.runId) {
        fields.push({ name: "Run ID", value: String(payload.runId), inline: false });
      }
      break;
    }
    case "block": {
      color = 15158332; // Red
      const reasons: string[] = payload?.decision?.reasons ?? (payload?.reason ? [payload.reason] : []);
      if (reasons.length > 0) {
        description = reasons.map(r => `• ${r}`).join("\n");
      } else {
        description = "No specific reasons provided.";
      }
      if (payload?.review?.estimatedNotional) {
        fields.push({ name: "Estimated Notional", value: `$${Number(payload.review.estimatedNotional).toFixed(2)}`, inline: true });
      }
      if (payload?.proposalId) {
        fields.push({ name: "Proposal ID", value: String(payload.proposalId), inline: true });
      }
      break;
    }
    case "pending_approval": {
      color = 15105570; // Orange
      const proposal = payload?.proposal;
      const review = payload?.review;
      if (proposal) {
        fields.push(
          { name: "Symbol", value: String(proposal.symbol), inline: true },
          { name: "Side", value: String(proposal.side).toUpperCase(), inline: true },
          { name: "Order Type", value: String(proposal.type), inline: true }
        );
        if (proposal.quantity) {
          fields.push({ name: "Quantity", value: String(proposal.quantity), inline: true });
        }
        if (proposal.dollarAmount) {
          fields.push({ name: "Dollar Amount", value: `$${Number(proposal.dollarAmount).toFixed(2)}`, inline: true });
        }
        if (review?.estimatedNotional) {
          fields.push({ name: "Estimated Notional", value: `$${Number(review.estimatedNotional).toFixed(2)}`, inline: true });
        }
        if (proposal.rationale) {
          description = `**Rationale:** ${proposal.rationale}`;
        }
      }
      if (payload?.proposalId) {
        fields.push({ name: "Proposal ID", value: String(payload.proposalId), inline: false });
      }
      break;
    }
    case "kill_switch": {
      color = 10181046; // Purple
      description = payload?.summary ?? "Kill switch triggered.";
      if (payload?.runId) {
        fields.push({ name: "Run ID", value: String(payload.runId), inline: false });
      }
      break;
    }
    case "run_failed": {
      color = 15158332; // Red
      description = payload?.summary ?? "Strategy run failed.";
      if (payload?.runId) {
        fields.push({ name: "Run ID", value: String(payload.runId), inline: false });
      }
      break;
    }
  }

  return {
    embeds: [
      {
        title,
        description: description || undefined,
        color,
        fields: fields.length > 0 ? fields : undefined,
        timestamp: new Date().toISOString()
      }
    ]
  };
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
