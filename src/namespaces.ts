import { createStores } from './server.js';
import { createBackend, type BackendConfig } from './stores/backend.js';
import { createGuardedStores, type Guard } from './guard.js';
import type { Stores } from './stores/interfaces.js';
import type { NotificationBus } from './bus.js';
import type { IncubatorEvent } from './types.js';
import type { ProtocolSpec } from '@agentcoordinationprotocol/spec';
import { TopicRouter, type TopicRouterOptions } from './honeycomb.js';

const RESERVED_NAMES = new Set(['_ns']);

function installNotifications(stores: Stores, bus: NotificationBus, namespace: string): void {
  // Patch the event store's publish method IN PLACE so that claims/discoveries
  // (which hold a direct reference to this same event store instance) also
  // trigger bus notifications for their internal events (claim.acquired, etc.)
  const original = stores.events.publish.bind(stores.events);
  stores.events.publish = async (type: string, data: unknown, agentId: string): Promise<IncubatorEvent> => {
    const event = await original(type, data, agentId);
    bus.publish(namespace, event);
    return event;
  };
}

export class NamespaceRegistry {
  private namespaces = new Map<string, Stores>();
  private protocols = new Map<string, ProtocolSpec>();
  private guard?: Guard;
  private verbose?: boolean;
  private telemetry?: { record(type: string, meta: Record<string, unknown>): void };
  private backendConfig: BackendConfig;
  private bus?: NotificationBus;
  private router?: TopicRouter;

  constructor(backendConfig?: BackendConfig) {
    this.backendConfig = backendConfig ?? { type: 'memory' };
  }

  setGuard(guard: Guard, verbose?: boolean, telemetry?: { record(type: string, meta: Record<string, unknown>): void }): void {
    this.guard = guard;
    this.verbose = verbose;
    this.telemetry = telemetry;
  }

  setBus(bus: NotificationBus, routerOptions?: TopicRouterOptions): void {
    this.bus = bus;
    this.router = new TopicRouter((ns) => this.get(ns), bus, routerOptions);

    // Re-register protocols loaded before the bus was set
    for (const [ns, spec] of this.protocols) {
      if (spec.topics) {
        this.router.registerProtocol(ns, spec);
      }
    }
  }

  getRouter(): TopicRouter | undefined {
    return this.router;
  }

  get(namespace: string): Stores {
    if (RESERVED_NAMES.has(namespace)) {
      throw new Error(`'${namespace}' is a reserved name and cannot be used as a namespace`);
    }

    // Validate namespace name
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(namespace)) {
      throw new Error(`Invalid namespace: must match /^[a-z0-9][a-z0-9_-]{0,63}$/`);
    }

    let stores = this.namespaces.get(namespace);
    if (stores) return stores;

    // Cap total namespace count
    if (this.namespaces.size >= 100) {
      throw new Error('Maximum namespace count (100) reached');
    }

    stores = createBackend({ ...this.backendConfig, namespace });
    if (this.bus) {
      // Install BEFORE guard wrapping — patches the raw event store that
      // claims/discoveries hold a direct reference to, so their internal
      // events (claim.acquired, discovery.published) also notify the bus.
      installNotifications(stores, this.bus, namespace);
    }
    if (this.guard) {
      stores = createGuardedStores(stores, this.guard, this.verbose, this.telemetry);
    }
    this.namespaces.set(namespace, stores);

    // Watch this namespace for cross-namespace topic routing
    if (this.router) {
      this.router.watch(namespace);
    }

    return stores;
  }

  list(): string[] {
    return [...this.namespaces.keys()];
  }

  delete(namespace: string): boolean {
    if (this.router) {
      this.router.clearNamespace(namespace);
    }
    return this.namespaces.delete(namespace);
  }

  has(namespace: string): boolean {
    return this.namespaces.has(namespace);
  }

  setProtocol(namespace: string, spec: ProtocolSpec): void {
    this.protocols.set(namespace, spec);
    if (this.router && spec.topics) {
      this.router.registerProtocol(namespace, spec);
    }
  }

  getProtocol(namespace: string): ProtocolSpec | undefined {
    return this.protocols.get(namespace);
  }
}
