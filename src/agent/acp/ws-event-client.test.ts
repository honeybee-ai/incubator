import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketEventClient } from './ws-event-client.js';
import { WebSocketServer } from 'ws';
import { createServer, type Server } from 'node:http';

let httpServer: Server;
let wss: WebSocketServer;
let port: number;

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    httpServer = createServer();
    wss = new WebSocketServer({ server: httpServer });
    httpServer.listen(0, () => {
      port = (httpServer.address() as { port: number }).port;
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    wss.close();
    httpServer.close(() => resolve());
  });
}

/** Send an event from "server" to all connected WS clients. */
function sendEvent(type: string, agentId: string, seq: number, data: unknown = {}) {
  const msg = JSON.stringify({ type, agentId, seq, data });
  for (const client of wss.clients) {
    client.send(msg);
  }
}

beforeEach(async () => {
  await startServer();
});

afterEach(async () => {
  await stopServer();
});

describe('WebSocketEventClient', () => {
  it('connects and buffers events', async () => {
    const client = new WebSocketEventClient(`http://localhost:${port}`, 'default', 'self-agent');
    await client.connect();

    sendEvent('test.event', 'other-agent', 1, { msg: 'hello' });

    // Small delay for message delivery
    await new Promise(r => setTimeout(r, 50));

    const events = client.drain();
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('other-agent');
    expect(events[0]).toContain('test.event');

    client.close();
  });

  it('filters own events from buffer', async () => {
    const client = new WebSocketEventClient(`http://localhost:${port}`, 'default', 'self-agent');
    await client.connect();

    sendEvent('my.event', 'self-agent', 1);
    sendEvent('their.event', 'other-agent', 2);

    await new Promise(r => setTimeout(r, 50));

    const events = client.drain();
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('other-agent');

    client.close();
  });

  it('drain returns empty and clears buffer', async () => {
    const client = new WebSocketEventClient(`http://localhost:${port}`, 'default', 'self-agent');
    await client.connect();

    sendEvent('test.event', 'other-agent', 1);
    await new Promise(r => setTimeout(r, 50));

    const first = client.drain();
    expect(first).toHaveLength(1);

    const second = client.drain();
    expect(second).toHaveLength(0);

    client.close();
  });

  it('waitForWake resolves immediately if buffer has matching event', async () => {
    const client = new WebSocketEventClient(`http://localhost:${port}`, 'default', 'self-agent');
    await client.connect();

    sendEvent('player.action', 'other-agent', 1, { action: 'attack' });
    await new Promise(r => setTimeout(r, 50));

    const events = await client.waitForWake({ types: ['player.action'] });
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('player.action');

    client.close();
  });

  it('waitForWake blocks until matching event arrives', async () => {
    const client = new WebSocketEventClient(`http://localhost:${port}`, 'default', 'self-agent');
    await client.connect();

    // Start waiting (will block)
    const promise = client.waitForWake({ types: ['player.action'] });

    // Send event after a delay
    setTimeout(() => sendEvent('player.action', 'other-agent', 1), 50);

    const events = await promise;
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('player.action');

    client.close();
  });

  it('waitForWake times out with empty array', async () => {
    const client = new WebSocketEventClient(`http://localhost:${port}`, 'default', 'self-agent');
    await client.connect();

    const events = await client.waitForWake({ types: ['never.happens'], timeout: 100 });
    expect(events).toHaveLength(0);

    client.close();
  });

  it('close resolves all pending waiters', async () => {
    const client = new WebSocketEventClient(`http://localhost:${port}`, 'default', 'self-agent');
    await client.connect();

    const promise = client.waitForWake({ types: ['test.event'] });

    // Close while waiting
    client.close();

    const events = await promise;
    expect(events).toHaveLength(0);
  });

  it('tracks cursor from event seq numbers', async () => {
    const client = new WebSocketEventClient(`http://localhost:${port}`, 'default', 'self-agent');
    await client.connect();

    sendEvent('a', 'other', 5);
    sendEvent('b', 'other', 10);
    await new Promise(r => setTimeout(r, 50));

    client.drain();
    expect(client.cursor).toBe(10);

    client.close();
  });

  it('stores and consumes lastInject from event messages', async () => {
    const client = new WebSocketEventClient(`http://localhost:${port}`, 'default', 'self-agent');
    await client.connect();

    // Send event with inject field (like incubator does for dance support)
    for (const c of wss.clients) {
      c.send(JSON.stringify({
        type: 'event',
        event: { type: 'game.start', data: {}, publishedBy: 'other', id: 1 },
        inject: 'You have 3 cards in hand.',
      }));
    }
    await new Promise(r => setTimeout(r, 50));

    const inject = client.getLastInject();
    expect(inject).toBe('You have 3 cards in hand.');

    // Second call should return null (consumed)
    const secondCall = client.getLastInject();
    expect(secondCall).toBeNull();

    client.close();
  });

  it('getLastInject returns null when no inject received', async () => {
    const client = new WebSocketEventClient(`http://localhost:${port}`, 'default', 'self-agent');
    await client.connect();

    expect(client.getLastInject()).toBeNull();

    client.close();
  });

  it('callDanceTool sends dance_call and resolves on dance_result', async () => {
    // Set up server to respond to dance_call with dance_result
    wss.on('connection', (ws) => {
      ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'dance_call') {
          ws.send(JSON.stringify({
            type: 'dance_result',
            callId: msg.callId,
            result: { result: { answer: 42 } },
          }));
        }
      });
    });

    const client = new WebSocketEventClient(`http://localhost:${port}`, 'default', 'self-agent', 'player');
    await client.connect();

    const result = await client.callDanceTool('roll_dice', { sides: 6 });
    expect(result).toEqual({ result: { answer: 42 } });

    client.close();
  });

  it('callDanceTool rejects when WebSocket is not connected', async () => {
    const client = new WebSocketEventClient(`http://localhost:${port}`, 'default', 'self-agent', 'player');
    // Don't connect

    await expect(client.callDanceTool('test', {})).rejects.toThrow('WebSocket not connected');
  });

  it('callDanceTool sends correctly formatted dance_call message', async () => {
    const receivedMessages: unknown[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString());
        receivedMessages.push(msg);
        // Respond immediately so the promise resolves
        if (msg.type === 'dance_call') {
          ws.send(JSON.stringify({
            type: 'dance_result',
            callId: msg.callId,
            result: { result: 'ack' },
          }));
        }
      });
    });

    const client = new WebSocketEventClient(`http://localhost:${port}`, 'default', 'self-agent', 'player');
    await client.connect();

    await client.callDanceTool('slow_tool', { x: 1 });

    expect(receivedMessages.length).toBeGreaterThanOrEqual(1);
    const msg = receivedMessages[receivedMessages.length - 1] as Record<string, unknown>;
    expect(msg.type).toBe('dance_call');
    expect(msg.tool).toBe('slow_tool');
    expect(msg.args).toEqual({ x: 1 });
    expect(msg.agentId).toBe('self-agent');
    expect(msg.role).toBe('player');
    expect(typeof msg.callId).toBe('string');

    client.close();
  });

  it('close resolves pending dance call resolvers', async () => {
    const client = new WebSocketEventClient(`http://localhost:${port}`, 'default', 'self-agent', 'player');
    await client.connect();

    // Start a dance call that won't be answered
    const dancePromise = client.callDanceTool('unanswered', {});

    // Close while pending
    client.close();

    // The callDanceTool has two code paths: the resolver gets { error: 'Client closed' }
    // but the Promise wrapper itself resolves since we clear resolvers
    const result = await dancePromise;
    expect(result).toEqual({ error: 'Client closed' });
  });

  it('sends agentId and role in connect URL params', async () => {
    let receivedUrl = '';
    // Track the URL from the next connection
    wss.once('connection', (_ws, req) => {
      receivedUrl = req.url ?? '';
    });

    const client = new WebSocketEventClient(`http://localhost:${port}`, 'myns', 'agent-42', 'dealer');
    await client.connect();

    expect(receivedUrl).toContain('namespace=myns');
    expect(receivedUrl).toContain('agentId=agent-42');
    expect(receivedUrl).toContain('role=dealer');

    client.close();
  });
});
