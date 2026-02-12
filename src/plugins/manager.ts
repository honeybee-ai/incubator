/**
 * PluginManager — unified plugin lifecycle, tool aggregation, auto-discovery.
 *
 * Replaces both IntegrationManager and tool-loader.ts with a single system.
 * Propolis auto-loads if installed. Legacy IntegrationModule packages are
 * wrapped automatically via the loader.
 */

import type {
  IncubatorPlugin,
  PluginContext,
  ToolEntry,
  ToolResult,
  IntegrationEvent,
} from '@honeybee-ai/hivemind-sdk/integrations';
import type { NotificationBus } from '../bus.js';
import type { IEventStore } from '../stores/interfaces.js';
import type { IntegrationEntry } from '../integrations/config.js';
import { loadPlugin } from './loader.js';

export interface BroodPluginEntry {
  package: string;
  config?: Record<string, string>;
}

export interface PluginManagerOptions {
  /** Try to auto-discover propolis on init(). Default: true. */
  autoDiscover?: boolean;
  /** Plugin packages passed via --plugin= CLI flags. */
  cliPlugins?: string[];
  /** Plugin entries from brood.yaml. */
  broodPlugins?: BroodPluginEntry[];
  /** Legacy integration entries (from integrations.json). */
  integrations?: Record<string, IntegrationEntry>;
  /** CLI-specified integration names (--integration= flags). */
  cliIntegrations?: string[];
}

interface LoadedPlugin {
  name: string;
  plugin: IncubatorPlugin;
  unsubscribe?: () => void;
  toolEntries: ToolEntry[];
}

type EnvHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export class PluginManager {
  private plugins: LoadedPlugin[] = [];
  private _toolNameSet = new Set<string>();
  private _handlerMap = new Map<string, EnvHandler>();
  private _allToolEntries: ToolEntry[] = [];
  private verbose: boolean;
  private namespace: string;
  private bus?: NotificationBus;
  private eventStore?: IEventStore;

  constructor(opts?: {
    verbose?: boolean;
    namespace?: string;
    bus?: NotificationBus;
    eventStore?: IEventStore;
  }) {
    this.verbose = opts?.verbose ?? false;
    this.namespace = opts?.namespace ?? 'default';
    this.bus = opts?.bus;
    this.eventStore = opts?.eventStore;
  }

  /**
   * Initialize the plugin system.
   * Auto-discovers propolis, loads CLI/brood plugins, wraps legacy integrations.
   */
  async init(opts?: PluginManagerOptions): Promise<void> {
    const autoDiscover = opts?.autoDiscover ?? true;

    // 1. Auto-discover propolis
    if (autoDiscover) {
      try {
        await this.load('propolis', '@honeybee-ai/propolis');
      } catch {
        this.log('No plugins auto-discovered');
      }
    }

    // 2. CLI plugins (--plugin=)
    if (opts?.cliPlugins) {
      for (const pkg of opts.cliPlugins) {
        try {
          await this.load(pkg, pkg);
        } catch (err) {
          console.error(`[plugins] Failed to load "${pkg}": ${(err as Error).message}`);
        }
      }
    }

    // 3. Brood.yaml plugins
    if (opts?.broodPlugins) {
      for (const entry of opts.broodPlugins) {
        // Skip propolis if already auto-discovered
        if (entry.package === '@honeybee-ai/propolis' && this.plugins.some(p => p.name === 'propolis')) {
          continue;
        }
        try {
          const name = entry.package.replace(/^@[^/]+\//, '');
          await this.load(name, entry.package, entry.config);
        } catch (err) {
          console.error(`[plugins] Failed to load "${entry.package}": ${(err as Error).message}`);
        }
      }
    }

    // 4. Legacy integrations
    if (opts?.integrations) {
      const cliIntNames = opts?.cliIntegrations ?? [];

      if (cliIntNames.length > 0) {
        // Load only CLI-specified integrations
        for (const name of cliIntNames) {
          const entry = opts.integrations[name];
          if (entry) {
            try {
              await this.load(name, entry.package, entry.config);
            } catch (err) {
              console.error(`[plugins] Failed to load integration "${name}": ${(err as Error).message}`);
            }
          } else {
            // Treat name as npm package name
            try {
              await this.load(name, name);
            } catch (err) {
              console.error(`[plugins] Failed to load integration "${name}": ${(err as Error).message}`);
            }
          }
        }
      } else {
        // Load all enabled integrations
        for (const [name, entry] of Object.entries(opts.integrations)) {
          if (!entry.enabled) continue;
          try {
            await this.load(name, entry.package, entry.config);
          } catch (err) {
            console.error(`[plugins] Failed to load integration "${name}": ${(err as Error).message}`);
          }
        }
      }
    }
  }

  /**
   * Load a single plugin by package name.
   * Deduplicates by name — loading the same name twice is a no-op.
   */
  async load(name: string, packageName: string, config?: Record<string, string>): Promise<void> {
    // Deduplicate
    if (this.plugins.some(p => p.name === name)) return;

    const plugin = await loadPlugin(packageName, config);

    // Start the plugin with a minimal context for lifecycle
    const ctx = this.buildContext(config);
    await plugin.start(ctx);

    // Subscribe to bus events if plugin has onEvent
    let unsubscribe: (() => void) | undefined;
    if (plugin.onEvent && this.bus) {
      unsubscribe = this.bus.subscribe(this.namespace, (event) => {
        const integrationEvent: IntegrationEvent = {
          type: event.type,
          data: event.data,
          agentId: event.publishedBy,
          namespace: this.namespace,
          timestamp: Date.now(),
        };
        plugin.onEvent!(integrationEvent).catch((err: unknown) => {
          console.error(`[plugins:${plugin.name}] onEvent error: ${(err as Error).message}`);
        });
      });
    }

    this.plugins.push({ name, plugin, unsubscribe, toolEntries: [] });
    this.log(`Loaded: ${plugin.name}`);
  }

  /**
   * Build tool entries from all plugins for the given context.
   * Must be called after init() and before getHandlerMap()/getToolEntries().
   */
  buildToolEntries(workDir: string, guard: unknown, verbose: boolean): void {
    this._allToolEntries = [];
    this._handlerMap.clear();
    this._toolNameSet.clear();

    const ctx: PluginContext = {
      ...this.buildContext(),
      workDir,
      guard,
      verbose,
    };

    for (const loaded of this.plugins) {
      if (loaded.plugin.getToolEntries) {
        const entries = loaded.plugin.getToolEntries(ctx);
        loaded.toolEntries = entries;

        for (const entry of entries) {
          const name = entry.def.function.name;
          if (this._toolNameSet.has(name)) {
            console.error(`[plugins] Tool name collision: "${name}" from "${loaded.name}" — skipping duplicate`);
            continue;
          }
          this._toolNameSet.add(name);
          this._handlerMap.set(name, entry.handler);
          this._allToolEntries.push(entry);
        }
      }
    }
  }

  /** All tool entries across all plugins. */
  getToolEntries(): ToolEntry[] {
    return this._allToolEntries;
  }

  /** Handler map (tool name → handler) for compound tool dispatch. */
  getHandlerMap(): Map<string, EnvHandler> {
    return this._handlerMap;
  }

  /** Set of all available tool names (for ENV_ACTIONS replacement). */
  getToolNames(): Set<string> {
    return this._toolNameSet;
  }

  /** Whether any plugins provide tool entries. */
  hasToolEntries(): boolean {
    return this._allToolEntries.length > 0;
  }

  /** Names of all loaded plugins. */
  getLoadedNames(): string[] {
    return this.plugins.map(p => p.name);
  }

  /** Tool count across all plugins. */
  getToolCount(): number {
    return this._allToolEntries.length;
  }

  /** Graceful shutdown: stop all plugins, destroy resources. */
  async destroyAll(): Promise<void> {
    for (const loaded of this.plugins) {
      try {
        if (loaded.unsubscribe) loaded.unsubscribe();
        await loaded.plugin.stop();
        if (loaded.plugin.destroy) loaded.plugin.destroy();
      } catch (err) {
        console.error(`[plugins] Error stopping "${loaded.name}": ${(err as Error).message}`);
      }
    }
    this.plugins = [];
    this._allToolEntries = [];
    this._handlerMap.clear();
    this._toolNameSet.clear();
  }

  private buildContext(config?: Record<string, string>): PluginContext {
    return {
      namespace: this.namespace,
      config: config ?? {},
      logger: {
        info: (msg: string) => { if (this.verbose) console.error(`[plugins] ${msg}`); },
        warn: (msg: string) => { console.error(`[plugins] WARN: ${msg}`); },
        error: (msg: string) => { console.error(`[plugins] ERROR: ${msg}`); },
      },
      publishEvent: async (type: string, data: unknown) => {
        if (this.eventStore) {
          await this.eventStore.publish(type, data, 'plugin');
        }
      },
      workDir: process.cwd(),
      guard: null,
      verbose: this.verbose,
    };
  }

  private log(msg: string): void {
    if (this.verbose) {
      console.error(`[plugins] ${msg}`);
    }
  }
}
