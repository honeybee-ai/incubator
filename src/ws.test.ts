import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { LocalBus } from './bus.js';
import { NamespaceRegistry } from './namespaces.js';
import { setupWebSocket, type WsManager, type DanceSupport } from './ws.js';
import type { IncubatorEvent } from './types.js';
import type { DanceModule, DanceAcpHelper } from './dances.js';

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

interface WsMsg { type: string; event?: IncubatorEvent; cursor?: number; ts?: number; message?: string; inject?: string; callId?: string; result?: unknown }

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

    wsManager = await setupWebSocket(httpServer, registry, bus, false, WsServer as never);

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

describe.skipIf(!wsAvailable)('WebSocket Dance Support', () => {
  let httpServer: HttpServer;
  let bus: LocalBus;
  let registry: NamespaceRegistry;
  let wsManager: WsManager;
  let port: number;
  const openSockets: WebSocket[] = [];

  function makeDanceSupport(injectResult: string | null = 'injected context', toolResult: unknown = { result: 'ok' }): DanceSupport {
    const mockModule: DanceModule = {
      inject: injectResult !== null
        ? (_ctx) => injectResult
        : undefined,
      tools: new Map([
        ['test_tool', {
          description: 'A test dance tool',
          params: { input: { type: 'string' } },
          handler: async (_ctx) => ({ result: toolResult }),
        }],
      ]),
    };

    const mockAcpHelper: DanceAcpHelper = {
      publish: async () => {},
      claim: async () => 'claim-id',
      release: async () => {},
      setState: async () => {},
    };

    return {
      module: mockModule,
      getState: async () => ({ key: 'value' }),
      getAcpHelper: () => mockAcpHelper,
    };
  }

  beforeEach(async () => {
    bus = new LocalBus();
    registry = new NamespaceRegistry();
    registry.setBus(bus);

    httpServer = createHttpServer((_, res) => {
      res.writeHead(404);
      res.end();
    });

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

  it('includes inject in event messages when danceSupport and agent params are present', async () => {
    const ds = makeDanceSupport('You are the dealer. Cards: A, K, Q.');
    wsManager = await setupWebSocket(httpServer, registry, bus, false, WsServer as never, ds);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    port = (httpServer.address() as { port: number }).port;

    const ws = await connect('/ws?namespace=default&agentId=agent1&role=dealer');
    await collectMessages(ws, 2); // replay_done + dance_tools

    const stores = registry.get('default');
    await stores.events.publish('game.start', { round: 1 }, 'agent2');

    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('event');
    expect(msg.inject).toBe('You are the dealer. Cards: A, K, Q.');
    expect(msg.event!.type).toBe('game.start');
  });

  it('omits inject when no agentId/role in connection', async () => {
    const ds = makeDanceSupport('should not appear');
    wsManager = await setupWebSocket(httpServer, registry, bus, false, WsServer as never, ds);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    port = (httpServer.address() as { port: number }).port;

    const ws = await connect('/ws?namespace=default');
    await collectMessages(ws, 2); // replay_done + dance_tools

    const stores = registry.get('default');
    await stores.events.publish('test.event', {}, 'agent2');

    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('event');
    expect(msg.inject).toBeUndefined();
  });

  it('omits inject field when inject function returns null', async () => {
    const ds = makeDanceSupport(null);
    wsManager = await setupWebSocket(httpServer, registry, bus, false, WsServer as never, ds);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    port = (httpServer.address() as { port: number }).port;

    const ws = await connect('/ws?namespace=default&agentId=agent1&role=player');
    await collectMessages(ws, 2); // replay_done + dance_tools

    const stores = registry.get('default');
    await stores.events.publish('test.event', {}, 'agent2');

    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('event');
    expect(msg.inject).toBeUndefined();
  });

  it('handles dance_call and returns dance_result', async () => {
    const ds = makeDanceSupport(null, { action: 'hit', card: '7' });
    wsManager = await setupWebSocket(httpServer, registry, bus, false, WsServer as never, ds);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    port = (httpServer.address() as { port: number }).port;

    const ws = await connect('/ws?namespace=default&agentId=agent1&role=player');
    await collectMessages(ws, 2); // replay_done + dance_tools

    // Send dance_call
    ws.send(JSON.stringify({
      type: 'dance_call',
      tool: 'test_tool',
      args: { input: 'hello' },
      callId: 'call_123',
      agentId: 'agent1',
      role: 'player',
    }));

    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('dance_result');
    expect(msg.callId).toBe('call_123');
    expect(msg.result).toEqual({ action: 'hit', card: '7' });
  });

  it('returns error dance_result for unknown tool', async () => {
    const ds = makeDanceSupport(null);
    wsManager = await setupWebSocket(httpServer, registry, bus, false, WsServer as never, ds);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    port = (httpServer.address() as { port: number }).port;

    const ws = await connect('/ws?namespace=default&agentId=agent1&role=player');
    await collectMessages(ws, 2); // replay_done + dance_tools

    ws.send(JSON.stringify({
      type: 'dance_call',
      tool: 'nonexistent_tool',
      args: {},
      callId: 'call_456',
    }));

    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('dance_result');
    expect(msg.callId).toBe('call_456');
    expect(msg.result).toEqual({ error: 'Unknown dance tool: nonexistent_tool' });
  });

  it('includes inject in replayed events when danceSupport is present', async () => {
    const ds = makeDanceSupport('replay inject');
    wsManager = await setupWebSocket(httpServer, registry, bus, false, WsServer as never, ds);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    port = (httpServer.address() as { port: number }).port;

    // Publish events before client connects
    const stores = registry.get('default');
    await stores.events.publish('game.setup', { round: 1 }, 'agent2');

    const ws = await connect('/ws?namespace=default&agentId=agent1&role=dealer');

    const msgs = await collectMessages(ws, 3);
    // First message is the replayed event
    expect(msgs[0].type).toBe('event');
    expect(msgs[0].inject).toBe('replay inject');
    // Second is replay_done
    expect(msgs[1].type).toBe('replay_done');
    // Third is dance_tools
    expect(msgs[2].type).toBe('dance_tools');
  });
});
