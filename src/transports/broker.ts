/**
 * IPCBroker — Unix socket server for cross-incubator Honeycomb routing.
 *
 * Accepts connections from IPCTransport clients (one per hive/incubator).
 * Routes topic events between hives based on their pub/sub declarations.
 */

import { createServer, type Server, type Socket } from 'node:net';
import type { BrokerMessage, TopicEvent } from './types.js';

interface HiveConnection {
  name: string;
  socket: Socket;
  publishes: Set<string>;
  subscribes: Set<string>;
}

export class IPCBroker {
  private server: Server | null = null;
  private hives = new Map<string, HiveConnection>();
  private socketMap = new Map<Socket, HiveConnection>();

  /** Start broker on a Unix domain socket. */
  async listen(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = createServer((socket) => this.onConnection(socket));
      srv.on('error', reject);
      srv.listen(socketPath, () => {
        this.server = srv;
        resolve();
      });
    });
  }

  /** Stop broker and disconnect all hives. */
  async close(): Promise<void> {
    for (const conn of this.hives.values()) {
      conn.socket.end();
    }
    this.hives.clear();
    this.socketMap.clear();
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  /** Get names of connected hives. */
  getConnectedHives(): string[] {
    return [...this.hives.keys()];
  }

  private onConnection(socket: Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as BrokerMessage;
          this.handleMessage(socket, msg);
        } catch {
          // Ignore malformed messages
        }
      }
    });

    socket.on('close', () => {
      const conn = this.socketMap.get(socket);
      if (conn) {
        this.hives.delete(conn.name);
        this.socketMap.delete(socket);
      }
    });

    socket.on('error', () => {
      // Socket errors are handled by 'close'
    });
  }

  private handleMessage(socket: Socket, msg: BrokerMessage): void {
    switch (msg.type) {
      case 'register': {
        const conn: HiveConnection = {
          name: msg.hive,
          socket,
          publishes: new Set(msg.publishes),
          subscribes: new Set(msg.subscribes),
        };
        this.hives.set(msg.hive, conn);
        this.socketMap.set(socket, conn);
        break;
      }
      case 'event': {
        this.routeEvent(msg.hive, msg.topic, msg.event);
        break;
      }
    }
  }

  private routeEvent(sourceHive: string, topic: string, event: TopicEvent): void {
    for (const [name, conn] of this.hives) {
      // Don't route back to source
      if (name === sourceHive) continue;
      // Only forward if target subscribes to this topic
      if (!conn.subscribes.has(topic)) continue;

      const forward: BrokerMessage = { type: 'forward', topic, event };
      conn.socket.write(JSON.stringify(forward) + '\n');
    }
  }
}
