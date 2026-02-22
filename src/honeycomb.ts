/**
 * Honeycomb — Cross-namespace event routing layer.
 *
 * Protocols declare `topics.publishes` and `topics.subscribes` in their spec.
 * When an event is published in a namespace whose protocol publishes that
 * event type as a topic, the router injects it into all subscribing namespaces.
 *
 * Loop prevention: routed events use `publishedBy: "honeycomb:<sourceNs>"`.
 * The router skips any event whose publishedBy starts with "honeycomb:".
 */

import type { NotificationBus } from './bus.js';
import type { Stores } from './stores/interfaces.js';
import type { IncubatorEvent } from './types.js';
import type { ProtocolSpec } from '@agentcoordinationprotocol/spec';
import type { HoneycombTransport, TopicEvent } from './transports/types.js';

// Re-export with new canonical names (old names kept for backwards compat)
export type { HoneycombTransport, HoneycombTransport as EventTransport } from './transports/types.js';

const HONEYCOMB_PREFIX = 'honeycomb:';

export interface TopicRouterOptions {
  transport?: HoneycombTransport;
  hiveName?: string;
  hivePublishes?: string[];
  hiveSubscribes?: string[];
}

export class TopicRouter {
  /** topic → set of subscribing namespace names */
  private subscribers = new Map<string, Set<string>>();
  /** namespace → set of topics it publishes */
  private publishers = new Map<string, Set<string>>();
  /** namespace → set of topics it subscribes to (for cleanup) */
  private subscriptions = new Map<string, Set<string>>();
  /** namespace → bus unsubscribe function */
  private unsubscribers = new Map<string, () => void>();
  /** Optional cross-hive transport */
  private transport?: HoneycombTransport;
  private hiveName?: string;
  private hivePublishes?: Set<string>;
  private transportUnsubs: (() => void)[] = [];

  constructor(
    private getStores: (namespace: string) => Stores,
    private bus: NotificationBus,
    options?: TopicRouterOptions,
  ) {
    if (options?.transport && options.hiveName) {
      this.transport = options.transport;
      this.hiveName = options.hiveName;
      this.hivePublishes = options.hivePublishes ? new Set(options.hivePublishes) : undefined;

      // Subscribe to incoming remote events for each hive-level subscription
      if (options.hiveSubscribes) {
        for (const topic of options.hiveSubscribes) {
          const unsub = options.transport.subscribe(topic, (event) => {
            this.injectRemoteEvent(topic, event);
          });
          this.transportUnsubs.push(unsub);
        }
      }
    }
  }

  /** Register topics from a loaded protocol spec. */
  registerProtocol(namespace: string, spec: ProtocolSpec): void {
    // Clear previous registrations for this namespace (idempotent)
    this.clearNamespace(namespace);

    if (!spec.topics) return;

    // Register published topics
    if (spec.topics.publishes && spec.topics.publishes.length > 0) {
      this.publishers.set(namespace, new Set(spec.topics.publishes));
    }

    // Register subscribed topics
    if (spec.topics.subscribes && spec.topics.subscribes.length > 0) {
      const subs = new Set(spec.topics.subscribes);
      this.subscriptions.set(namespace, subs);
      for (const topic of subs) {
        let set = this.subscribers.get(topic);
        if (!set) {
          set = new Set();
          this.subscribers.set(topic, set);
        }
        set.add(namespace);
      }
    }

    // Ensure the router is watching this namespace for outgoing events
    this.watch(namespace);
  }

  /** Subscribe router to a namespace's bus events. */
  watch(namespace: string): void {
    // Don't double-watch
    if (this.unsubscribers.has(namespace)) return;

    const unsub = this.bus.subscribe(namespace, (event) => {
      this.route(namespace, event);
    });
    this.unsubscribers.set(namespace, unsub);
  }

  /** Route an event from source namespace to subscribers. */
  private route(sourceNamespace: string, event: IncubatorEvent): void {
    // Loop prevention: skip events already routed by honeycomb
    if (event.publishedBy.startsWith(HONEYCOMB_PREFIX)) return;

    // Check if this namespace publishes this event type as a topic
    const published = this.publishers.get(sourceNamespace);
    if (!published || !published.has(event.type)) return;

    // Local routing: find all subscribing namespaces within this incubator
    const subs = this.subscribers.get(event.type);
    if (subs && subs.size > 0) {
      for (const targetNs of subs) {
        // Don't route back to self
        if (targetNs === sourceNamespace) continue;

        const stores = this.getStores(targetNs);
        stores.events.publish(
          event.type,
          { ...(event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : { value: event.data }), _source: sourceNamespace },
          `${HONEYCOMB_PREFIX}${sourceNamespace}`,
        ).catch(() => {
          // Best-effort routing — don't crash if a target namespace has issues
        });
      }
    }

    // Cross-hive routing: publish to transport if topic is in hive-level publishes
    if (this.transport && this.hiveName) {
      if (!this.hivePublishes || this.hivePublishes.has(event.type)) {
        const topicEvent: TopicEvent = {
          sourceHive: this.hiveName,
          topic: event.type,
          data: event.data,
          publishedBy: event.publishedBy,
          timestamp: event.publishedAt,
        };
        this.transport.publish(event.type, topicEvent).catch(() => {
          // Best-effort cross-hive routing
        });
      }
    }
  }

  /** Inject a remote event received via transport into local namespaces. */
  injectRemoteEvent(topic: string, event: TopicEvent): void {
    const subs = this.subscribers.get(topic);
    if (!subs || subs.size === 0) return;

    const source = `${HONEYCOMB_PREFIX}${event.sourceHive}`;
    for (const targetNs of subs) {
      const stores = this.getStores(targetNs);
      stores.events.publish(
        topic,
        { ...(event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : { value: event.data }), _source: event.sourceHive },
        source,
      ).catch(() => {
        // Best-effort injection
      });
    }
  }

  /** Clean up when a namespace is deleted. */
  clearNamespace(namespace: string): void {
    // Remove from publishers
    this.publishers.delete(namespace);

    // Remove from subscriber sets
    const subs = this.subscriptions.get(namespace);
    if (subs) {
      for (const topic of subs) {
        const set = this.subscribers.get(topic);
        if (set) {
          set.delete(namespace);
          if (set.size === 0) this.subscribers.delete(topic);
        }
      }
      this.subscriptions.delete(namespace);
    }

    // Unsubscribe from bus
    const unsub = this.unsubscribers.get(namespace);
    if (unsub) {
      unsub();
      this.unsubscribers.delete(namespace);
    }
  }

  /** Runtime: subscribe a namespace to a topic. */
  subscribe(namespace: string, topic: string): void {
    let subs = this.subscriptions.get(namespace);
    if (!subs) {
      subs = new Set();
      this.subscriptions.set(namespace, subs);
    }
    subs.add(topic);

    let set = this.subscribers.get(topic);
    if (!set) {
      set = new Set();
      this.subscribers.set(topic, set);
    }
    set.add(namespace);
  }

  /** Runtime: unsubscribe a namespace from a topic. */
  unsubscribe(namespace: string, topic: string): void {
    const subs = this.subscriptions.get(namespace);
    if (subs) {
      subs.delete(topic);
      if (subs.size === 0) this.subscriptions.delete(namespace);
    }

    const set = this.subscribers.get(topic);
    if (set) {
      set.delete(namespace);
      if (set.size === 0) this.subscribers.delete(topic);
    }
  }

  /** Runtime: declare a namespace as publishing a topic. */
  publish(namespace: string, topic: string): void {
    let pubs = this.publishers.get(namespace);
    if (!pubs) {
      pubs = new Set();
      this.publishers.set(namespace, pubs);
    }
    pubs.add(topic);

    // Ensure we're watching this namespace
    this.watch(namespace);
  }

  /** Runtime: remove a namespace's published topic. */
  unpublish(namespace: string, topic: string): void {
    const pubs = this.publishers.get(namespace);
    if (pubs) {
      pubs.delete(topic);
      if (pubs.size === 0) this.publishers.delete(namespace);
    }
  }

  /** Query: get topics for a namespace. */
  getTopics(namespace: string): { publishes: string[]; subscribes: string[] } {
    const pubs = this.publishers.get(namespace);
    const subs = this.subscriptions.get(namespace);
    return {
      publishes: pubs ? [...pubs] : [],
      subscribes: subs ? [...subs] : [],
    };
  }

  /** Query: get all namespaces subscribing to a topic. */
  getSubscribersForTopic(topic: string): string[] {
    const set = this.subscribers.get(topic);
    return set ? [...set] : [];
  }
}
