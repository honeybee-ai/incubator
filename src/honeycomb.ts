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

const HONEYCOMB_PREFIX = 'honeycomb:';

export class TopicRouter {
  /** topic → set of subscribing namespace names */
  private subscribers = new Map<string, Set<string>>();
  /** namespace → set of topics it publishes */
  private publishers = new Map<string, Set<string>>();
  /** namespace → set of topics it subscribes to (for cleanup) */
  private subscriptions = new Map<string, Set<string>>();
  /** namespace → bus unsubscribe function */
  private unsubscribers = new Map<string, () => void>();

  constructor(
    private getStores: (namespace: string) => Stores,
    private bus: NotificationBus,
  ) {}

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

    // Find all subscribing namespaces
    const subs = this.subscribers.get(event.type);
    if (!subs || subs.size === 0) return;

    for (const targetNs of subs) {
      // Don't route back to self
      if (targetNs === sourceNamespace) continue;

      const stores = this.getStores(targetNs);
      // Inject event into target namespace's event store
      stores.events.publish(
        event.type,
        { ...(event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : { value: event.data }), _source: sourceNamespace },
        `${HONEYCOMB_PREFIX}${sourceNamespace}`,
      ).catch(() => {
        // Best-effort routing — don't crash if a target namespace has issues
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
