import { createRequire } from 'node:module';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { NotificationBus } from './bus.js';
import type { NamespaceRegistry } from './namespaces.js';
import type { IncubatorEvent } from './types.js';

interface WebSocketLike {
  send(data: string): void;
  close(): void;
  readyState: number;
  on(event: string, cb: (...args: unknown[]) => void): void;
  OPEN: number;
}

interface WebSocketServerLike {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WebSocketLike) => void): void;
  close(): void;
  clients: Set<WebSocketLike>;
}

export interface WsManager {
  close(): void;
}

const PING_INTERVAL = 30_000;

function loadWebSocketServer(): new (opts: { noServer: true }) => WebSocketServerLike {
  const require = createRequire(import.meta.url);
  const ws = require('ws') as { WebSocketServer: new (opts: { noServer: true }) => WebSocketServerLike };
  return ws.WebSocketServer;
}

export function setupWebSocket(
  httpServer: HttpServer,
  registry: NamespaceRegistry,
  bus: NotificationBus,
  verbose?: boolean,
  /** @internal for testing — inject WebSocketServer to avoid createRequire issues in vitest */
  WebSocketServerOverride?: new (opts: { noServer: true }) => WebSocketServerLike,
): WsManager {
  const WebSocketServer = WebSocketServerOverride ?? loadWebSocketServer();
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, url, registry, bus, verbose);
    });
  });

  return {
    close() {
      wss.close();
    },
  };
}

function handleConnection(
  ws: WebSocketLike,
  url: URL,
  registry: NamespaceRegistry,
  bus: NotificationBus,
  verbose?: boolean,
): void {
  const namespace = url.searchParams.get('namespace') ?? 'default';
  const sinceParam = url.searchParams.get('since');
  const since = sinceParam !== null ? parseInt(sinceParam, 10) : undefined;
  const typesParam = url.searchParams.get('types');
  let typeFilter: Set<string> | null = typesParam ? new Set(typesParam.split(',').filter(Boolean)) : null;

  // Buffer for events arriving during replay
  const buffer: IncubatorEvent[] = [];
  let replaying = true;
  let replayCursor = since ?? 0;

  function send(msg: unknown): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function matchesFilter(event: IncubatorEvent): boolean {
    if (!typeFilter) return true;
    return typeFilter.has(event.type);
  }

  // Subscribe to bus FIRST (buffer during replay)
  const unsubscribe = bus.subscribe(namespace, (event) => {
    if (!matchesFilter(event)) return;
    if (replaying) {
      buffer.push(event);
    } else {
      send({ type: 'event', event });
    }
  });

  // Replay from store
  const stores = registry.get(namespace);
  stores.events.getEvents(since).then(({ events, cursor }) => {
    // Send replayed events
    for (const event of events) {
      if (matchesFilter(event)) {
        send({ type: 'event', event });
        replayCursor = Math.max(replayCursor, event.id);
      }
    }
    replayCursor = Math.max(replayCursor, cursor);

    // Send replay_done marker
    send({ type: 'replay_done', cursor: replayCursor });

    // Flush buffer (de-dup: skip events already sent via replay)
    replaying = false;
    for (const event of buffer) {
      if (event.id > replayCursor) {
        send({ type: 'event', event });
      }
    }
    buffer.length = 0;

    if (verbose) {
      console.error(`[incubator] WS client connected: ns=${namespace} since=${since ?? 'start'} replayed=${events.length}`);
    }
  }).catch((err) => {
    send({ type: 'error', message: 'Replay failed' });
    if (verbose) console.error('[incubator] WS replay error:', err);
    ws.close();
  });

  // Handle client messages
  ws.on('message', (raw: unknown) => {
    try {
      const msg = JSON.parse(String(raw)) as { type: string; types?: string[] | null };
      if (msg.type === 'subscribe') {
        typeFilter = msg.types ? new Set(msg.types) : null;
      }
    } catch {
      // ignore malformed messages
    }
  });

  // Ping keepalive
  const pingTimer = setInterval(() => {
    send({ type: 'ping', ts: Date.now() });
  }, PING_INTERVAL);

  // Cleanup on close/error
  const cleanup = () => {
    clearInterval(pingTimer);
    unsubscribe();
    if (verbose) {
      console.error(`[incubator] WS client disconnected: ns=${namespace}`);
    }
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}
