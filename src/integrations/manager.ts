/**
 * IntegrationManager — lifecycle, event routing, tool aggregation.
 *
 * Loads integration packages, calls start(ctx)/stop(), subscribes onEvent()
 * to NotificationBus, and aggregates getTools() for MCP registration.
 */

import type {
  IntegrationModule,
  IntegrationContext,
  IntegrationEvent,
  IntegrationLogger,
  ToolDefinition,
} from '@honeybee-ai/hivemind-sdk/integrations';
import type { NotificationBus } from '../bus.js';
import type { IEventStore } from '../stores/interfaces.js';
import type { IntegrationEntry } from './config.js';
import { loadIntegrationPackage } from './loader.js';

interface LoadedIntegration {
  name: string;
  module: IntegrationModule;
  unsubscribe?: () => void;
}

export class IntegrationManager {
  private integrations: LoadedIntegration[] = [];
  private bus?: NotificationBus;
  private namespace: string;
  private eventStore?: IEventStore;
  private verbose: boolean;

  constructor(opts: { namespace?: string; bus?: NotificationBus; eventStore?: IEventStore; verbose?: boolean }) {
    this.namespace = opts.namespace ?? 'default';
    this.bus = opts.bus;
    this.eventStore = opts.eventStore;
    this.verbose = opts.verbose ?? false;
  }

  async loadFromConfig(entries: Record<string, IntegrationEntry>): Promise<void> {
    const enabled = Object.entries(entries).filter(([, e]) => e.enabled);
    for (const [name, entry] of enabled) {
      try {
        await this.load(name, entry.package, entry.config);
      } catch (err) {
        console.error(`[integrations] Failed to load "${name}": ${(err as Error).message}`);
      }
    }
  }

  async load(name: string, packageName: string, config: Record<string, string> = {}): Promise<void> {
    const module = await loadIntegrationPackage(packageName);

    const logger = this.createLogger(module.name);
    const ctx: IntegrationContext = {
      namespace: this.namespace,
      config,
      logger,
      publishEvent: async (type: string, data: unknown) => {
        if (this.eventStore) {
          await this.eventStore.publish(type, data, `integration:${module.name}`);
        }
      },
    };

    await module.start(ctx);
    logger.info('Started');

    // Subscribe to bus events if integration has onEvent
    let unsubscribe: (() => void) | undefined;
    if (module.onEvent && this.bus) {
      unsubscribe = this.bus.subscribe(this.namespace, (event) => {
        const integrationEvent: IntegrationEvent = {
          type: event.type,
          data: event.data,
          agentId: event.publishedBy,
          namespace: this.namespace,
          timestamp: Date.now(),
        };
        module.onEvent!(integrationEvent).catch((err) => {
          logger.error(`onEvent error: ${(err as Error).message}`);
        });
      });
    }

    this.integrations.push({ name, module, unsubscribe });
  }

  getTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const { module } of this.integrations) {
      if (module.getTools) {
        tools.push(...module.getTools());
      }
    }
    return tools;
  }

  getLoadedNames(): string[] {
    return this.integrations.map((i) => i.name);
  }

  async stopAll(): Promise<void> {
    for (const integration of this.integrations) {
      try {
        if (integration.unsubscribe) integration.unsubscribe();
        await integration.module.stop();
        if (this.verbose) {
          console.error(`[integrations] Stopped: ${integration.name}`);
        }
      } catch (err) {
        console.error(`[integrations] Error stopping "${integration.name}": ${(err as Error).message}`);
      }
    }
    this.integrations = [];
  }

  private createLogger(name: string): IntegrationLogger {
    const prefix = `[int:${name}]`;
    return {
      info: (msg: string, ...args: unknown[]) => {
        if (this.verbose) console.error(`${prefix} ${msg}`, ...args);
      },
      warn: (msg: string, ...args: unknown[]) => {
        console.error(`${prefix} WARN: ${msg}`, ...args);
      },
      error: (msg: string, ...args: unknown[]) => {
        console.error(`${prefix} ERROR: ${msg}`, ...args);
      },
    };
  }
}
