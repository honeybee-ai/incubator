import { EventEmitter } from 'node:events';
import type { IncubatorEvent } from './types.js';
import type { Redis } from './stores/redis/db.js';

export interface NotificationBus {
  publish(namespace: string, event: IncubatorEvent): void;
  subscribe(namespace: string, listener: (event: IncubatorEvent) => void): () => void;
  close(): Promise<void>;
}

// ─── LocalBus ────────────────────────────────────────────────

export class LocalBus implements NotificationBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(namespace: string, event: IncubatorEvent): void {
    this.emitter.emit(`ns:${namespace}`, event);
  }

  subscribe(namespace: string, listener: (event: IncubatorEvent) => void): () => void {
    const channel = `ns:${namespace}`;
    this.emitter.on(channel, listener);
    return () => { this.emitter.removeListener(channel, listener); };
  }

  close(): Promise<void> {
    this.emitter.removeAllListeners();
    return Promise.resolve();
  }
}

// ─── RedisBus ────────────────────────────────────────────────

export class RedisBus implements NotificationBus {
  private pub: Redis;
  private sub: Redis;
  private listeners = new Map<string, Set<(event: IncubatorEvent) => void>>();
  private subscribed = new Set<string>();

  constructor(pub: Redis, sub: Redis) {
    this.pub = pub;
    this.sub = sub;

    (this.sub as unknown as { on(event: string, cb: (channel: string, message: string) => void): void })
      .on('message', (channel: string, message: string) => {
        const fns = this.listeners.get(channel);
        if (!fns) return;
        try {
          const event = JSON.parse(message) as IncubatorEvent;
          for (const fn of fns) fn(event);
        } catch {
          // ignore malformed messages
        }
      });
  }

  publish(namespace: string, event: IncubatorEvent): void {
    const channel = `incubator:${namespace}:live`;
    this.pub.publish(channel, JSON.stringify(event)).catch(() => {});
  }

  subscribe(namespace: string, listener: (event: IncubatorEvent) => void): () => void {
    const channel = `incubator:${namespace}:live`;

    let fns = this.listeners.get(channel);
    if (!fns) {
      fns = new Set();
      this.listeners.set(channel, fns);
    }
    fns.add(listener);

    // Subscribe to Redis channel if first listener
    if (!this.subscribed.has(channel)) {
      this.subscribed.add(channel);
      (this.sub as unknown as { subscribe(channel: string): Promise<unknown> })
        .subscribe(channel).catch(() => {});
    }

    return () => {
      fns!.delete(listener);
      if (fns!.size === 0) {
        this.listeners.delete(channel);
        this.subscribed.delete(channel);
        (this.sub as unknown as { unsubscribe(channel: string): Promise<unknown> })
          .unsubscribe(channel).catch(() => {});
      }
    };
  }

  async close(): Promise<void> {
    this.listeners.clear();
    this.subscribed.clear();
    await this.sub.quit();
  }
}
