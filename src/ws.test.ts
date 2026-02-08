import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { LocalBus } from './bus.js';
import { NamespaceRegistry } from './namespaces.js';
import { setupWebSocket, type WsManager } from './ws.js';
import type { IncubatorEvent } from './types.js';

// Load WebSocketServer via createRequire (CJS) — used for server side
let WsServer: unknown;
let wsAvailable = false;
try {
  const require = createRequire(import.meta.url);
  const ws = require('ws');
  WsServer = ws.WebSocketServer;
  wsAvailable = true;
} catch {
  // ws not installed
}

// Use Node.js native WebSocket for the client (ws module client doesn't work in vitest's VM)

interface WsMsg { type: string; event?: IncubatorEvent; cursor?: number; ts?: number; message?: string }

function waitForMessage(ws: WebSocket): Promise<WsMsg> {
  return new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string) as WsMsg;
      // Skip pings
      if (msg.type === 'ping') return;
      ws.removeEventListener('message', handler);
      resolve(msg);
    };
    ws.addEventListener('message', handler);
  });
}

function collectMessages(ws: WebSocket, count: number): Promise<WsMsg[]> {
  return new Promise((resolve) => {
    const msgs: WsMsg[] = [];
    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string) as WsMsg;
      if (msg.type === 'ping') return;
      msgs.push(msg);
      if (msgs.length >= count) {
        ws.removeEventListener('message', handler);
        resolve(msgs);
      }
    };
    ws.addEventListener('message', handler);
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.addEventListener('close', () => resolve(), { once: true });
    ws.close();
  });
}

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket connect failed')), { once: true });
  });
}

describe.skipIf(!wsAvailable)('WebSocket Manager', () => {
  let httpServer: HttpServer;
  let bus: LocalBus;
  let registry: NamespaceRegistry;
  let wsManager: WsManager;
  let port: number;
  const openSockets: WebSocket[] = [];

  beforeEach(async () => {
    bus = new LocalBus();
    registry = new NamespaceRegistry();
    registry.setBus(bus);

    httpServer = createHttpServer((_, res) => {
      res.writeHead(404);
      res.end();
    });

    wsManager = setupWebSocket(httpServer, registry, bus, false, WsServer as never);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    port = (httpServer.address() as { port: number }).port;
    openSockets.length = 0;
  });

  afterEach(async () => {
    await Promise.all(openSockets.map(closeWs));
    openSockets.length = 0;
    wsManager.close();
    await bus.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  async function connect(path = '/ws'): Promise<WebSocket> {
    const ws = await openWs(`ws://localhost:${port}${path}`);
    openSockets.push(ws);
    return ws;
  }

  it('connects and receives replay_done', async () => {
    const ws = await connect();
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('replay_done');
    expect(msg.cursor).toBe(0);
  });

  it('replays events since cursor', async () => {
    const stores = registry.get('default');
    await stores.events.publish('alpha', { n: 1 }, 'agent1');
    await stores.events.publish('beta', { n: 2 }, 'agent2');
    await stores.events.publish('gamma', { n: 3 }, 'agent3');

    const ws = await connect('/ws?since=1');

    const msgs = await collectMessages(ws, 3);

    expect(msgs[0].type).toBe('event');
    expect(msgs[0].event!.type).toBe('beta');
    expect(msgs[1].type).toBe('event');
    expect(msgs[1].event!.type).toBe('gamma');
    expect(msgs[2].type).toBe('replay_done');
  });

  it('receives live events after replay', async () => {
    const ws = await connect();
    await waitForMessage(ws); // replay_done

    const stores = registry.get('default');
    await stores.events.publish('live.test', { hello: 'world' }, 'agent1');

    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('event');
    expect(msg.event!.type).toBe('live.test');
    expect(msg.event!.data).toEqual({ hello: 'world' });
  });

  it('filters events by types', async () => {
    const stores = registry.get('default');
    await stores.events.publish('keep', { n: 1 }, 'agent1');
    await stores.events.publish('drop', { n: 2 }, 'agent2');
    await stores.events.publish('keep', { n: 3 }, 'agent3');

    const ws = await connect('/ws?types=keep');

    const msgs = await collectMessages(ws, 3);

    expect(msgs[0].type).toBe('event');
    expect(msgs[0].event!.type).toBe('keep');
    expect(msgs[1].type).toBe('event');
    expect(msgs[1].event!.type).toBe('keep');
    expect(msgs[2].type).toBe('replay_done');
  });

  it('isolates namespaces', async () => {
    const stores1 = registry.get('ns1');
    await stores1.events.publish('ns1.event', { ns: 1 }, 'agent1');

    const ws = await connect('/ws?namespace=ns2');

    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('replay_done');
    expect(msg.cursor).toBe(0);
  });

  it('updates type filter via subscribe message', async () => {
    const ws = await connect();
    await waitForMessage(ws); // replay_done

    const stores = registry.get('default');

    ws.send(JSON.stringify({ type: 'subscribe', types: ['wanted'] }));
    await new Promise(r => setTimeout(r, 10));

    await stores.events.publish('unwanted', {}, 'agent1');
    await stores.events.publish('wanted', { got: 'it' }, 'agent2');

    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('event');
    expect(msg.event!.type).toBe('wanted');
  });

  it('rejects non-/ws upgrade requests', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/other`);
    // Don't add to openSockets — the socket will close itself on error
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('error', () => resolve(), { once: true });
      ws.addEventListener('open', () => reject(new Error('Should not have connected')), { once: true });
    });
  });
});
