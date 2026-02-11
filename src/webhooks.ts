import { createHmac } from 'node:crypto';
import type { NotificationBus } from './bus.js';
import type { IncubatorEvent } from './types.js';

export interface WebhookConfig {
  url: string;
  events?: string[];
  headers?: Record<string, string>;
  secret?: string;
}

/**
 * Manages webhook subscriptions for a namespace.
 * Subscribes to the notification bus and fires HTTP POSTs when events match.
 * Fire-and-forget: failures are logged, never block the event bus.
 */
export class WebhookManager {
  private unsubscribers: Array<() => void> = [];
  private verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  /**
   * Register webhooks for a namespace. Subscribes to the bus and fires POSTs on match.
   */
  register(namespace: string, webhooks: WebhookConfig[], bus: NotificationBus): void {
    for (const webhook of webhooks) {
      const filterSet = webhook.events ? new Set(webhook.events) : null;

      const unsub = bus.subscribe(namespace, (event: IncubatorEvent) => {
        // Check event type filter
        if (filterSet && !filterSet.has(event.type)) return;

        // Fire and forget
        this.fire(webhook, event).catch(err => {
          if (this.verbose) {
            console.error(`[webhooks] Failed to deliver to ${webhook.url}: ${(err as Error).message}`);
          }
        });
      });

      this.unsubscribers.push(unsub);
    }

    if (this.verbose && webhooks.length > 0) {
      console.error(`[webhooks] Registered ${webhooks.length} webhook(s) for namespace "${namespace}"`);
    }
  }

  /**
   * Unsubscribe all webhook listeners.
   */
  close(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  private async fire(webhook: WebhookConfig, event: IncubatorEvent): Promise<void> {
    const payload = JSON.stringify({
      event: event.type,
      data: event.data,
      publishedBy: event.publishedBy,
      publishedAt: event.publishedAt,
      id: event.id,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...webhook.headers,
    };

    // HMAC-SHA256 signature if secret provided
    if (webhook.secret) {
      const signature = createHmac('sha256', webhook.secret)
        .update(payload)
        .digest('hex');
      headers['X-Webhook-Signature'] = signature;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      await fetch(webhook.url, {
        method: 'POST',
        headers,
        body: payload,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
