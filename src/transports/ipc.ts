/**
 * IPCTransport — Unix socket client for cross-incubator Honeycomb events.
 *
 * Connects to the IPCBroker started by `wgl up`. Sends/receives NDJSON
 * messages over a Unix domain socket.
 */

import { connect, type Socket } from 'node:net';
import type { HoneycombTransport, TopicEvent, BrokerMessage } from './types.js';

export interface IPCTransportOptions {
  socketPath: string;
  hiveName: string;
  publishes: string[];
  subscribes: string[];
}

export class IPCTransport implements HoneycombTransport {
  private socket: Socket | null = null;
  private handlers = new Map<string, Set<(event: TopicEvent) => void>>();
  private buffer = '';
  private opts: IPCTransportOptions;

  constructor(opts: IPCTransportOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = connect(this.opts.socketPath, () => {
        this.socket = sock;
        // Register with broker
        this.send({
          type: 'register',
          hive: this.opts.hiveName,
          publishes: this.opts.publishes,
          subscribes: this.opts.subscribes,
        });
        resolve();
      });

      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => this.onData(chunk));
      sock.on('error', (err) => {
        if (!this.socket) reject(err);
      });
    });
  }

  async publish(topic: string, event: TopicEvent): Promise<void> {
    this.send({
      type: 'event',
      hive: this.opts.hiveName,
      topic,
      event,
    });
  }

  subscribe(topic: string, handler: (event: TopicEvent) => void): () => void {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.handlers.delete(topic);
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
  }

  private send(msg: BrokerMessage): void {
    if (this.socket) {
      this.socket.write(JSON.stringify(msg) + '\n');
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop()!; // keep incomplete line in buffer

    for (const line of lines) {
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as BrokerMessage;
        if (msg.type === 'forward') {
          const set = this.handlers.get(msg.topic);
          if (set) {
            for (const handler of set) handler(msg.event);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    }
  }
}
