import type {
  IntegrationModule,
  IntegrationFactory,
  IntegrationContext,
  IntegrationEvent,
} from '@honeybee-ai/hivemind-sdk/integrations';
import { createHmac } from 'node:crypto';

interface WebhookState {
  url: string;
  secret?: string;
  eventTypes?: string[];
  timeout: number;
  verbose: boolean;
  ctx?: IntegrationContext;
}

function createWebhookIntegration(): IntegrationModule {
  const state: WebhookState = {
    url: '',
    timeout: 5000,
    verbose: false,
  };

  return {
    name: 'webhook',

    async start(ctx: IntegrationContext): Promise<void> {
      const url = ctx.config.WEBHOOK_URL;
      if (!url) {
        throw new Error('WEBHOOK_URL config is required');
      }

      state.url = url;
      state.secret = ctx.config.WEBHOOK_SECRET;
      state.timeout = ctx.config.WEBHOOK_TIMEOUT
        ? parseInt(ctx.config.WEBHOOK_TIMEOUT, 10)
        : 5000;
      state.verbose = ctx.config.VERBOSE === 'true';
      state.ctx = ctx;

      // Parse optional event type filter
      if (ctx.config.EVENT_TYPES) {
        state.eventTypes = ctx.config.EVENT_TYPES.split(',').map(t => t.trim()).filter(Boolean);
      }

      ctx.logger.info(`Webhook endpoint: ${url}`);
      if (state.eventTypes) {
        ctx.logger.info(`Filtering events: ${state.eventTypes.join(', ')}`);
      }
    },

    async stop(): Promise<void> {
      state.ctx = undefined;
    },

    async onEvent(event: IntegrationEvent): Promise<void> {
      // Filter by event type if configured
      if (state.eventTypes && !state.eventTypes.includes(event.type)) {
        return;
      }

      const payload = JSON.stringify({
        type: event.type,
        data: event.data,
        agent_id: event.agentId,
        namespace: event.namespace,
        timestamp: event.timestamp,
      });

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'Honeybee-Webhook/0.1',
        'X-Honeybee-Event': event.type,
        'X-Honeybee-Namespace': event.namespace,
      };

      // HMAC signature if secret is configured
      if (state.secret) {
        const sig = createHmac('sha256', state.secret).update(payload).digest('hex');
        headers['X-Honeybee-Signature'] = `sha256=${sig}`;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), state.timeout);

      try {
        const res = await fetch(state.url, {
          method: 'POST',
          headers,
          body: payload,
          signal: controller.signal,
        });

        if (state.verbose && state.ctx) {
          state.ctx.logger.info(`POST ${state.url} → ${res.status}`);
        }

        if (!res.ok && state.ctx) {
          state.ctx.logger.warn(`Webhook returned ${res.status}: ${res.statusText}`);
        }
      } catch (err) {
        if (state.ctx) {
          const msg = (err as Error).name === 'AbortError'
            ? `Webhook timeout (${state.timeout}ms)`
            : `Webhook error: ${(err as Error).message}`;
          state.ctx.logger.error(msg);
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export default createWebhookIntegration;
export { createWebhookIntegration as createIntegration };
