/**
 * Honeycomb transport layer — cross-incubator event routing.
 *
 * Level 1 (within-incubator) uses TopicRouter directly.
 * Level 2 (cross-incubator) uses HoneycombTransport over IPC/TCP.
 */

export interface TopicEvent {
  sourceHive: string;
  topic: string;
  data: unknown;
  publishedBy: string;
  timestamp: string;
}

export interface HoneycombTransport {
  /** Publish a topic event to remote hives. */
  publish(topic: string, event: TopicEvent): Promise<void>;
  /** Subscribe to incoming events for a topic. Returns unsubscribe fn. */
  subscribe(topic: string, handler: (event: TopicEvent) => void): () => void;
  /** Connect to broker (if applicable). */
  connect(): Promise<void>;
  /** Disconnect from broker. */
  close(): Promise<void>;
}

/** Wire protocol messages (NDJSON over Unix socket). */
export type BrokerMessage =
  | { type: 'register'; hive: string; publishes: string[]; subscribes: string[] }
  | { type: 'event'; hive: string; topic: string; event: TopicEvent }
  | { type: 'forward'; topic: string; event: TopicEvent };
