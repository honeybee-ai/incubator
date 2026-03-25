import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { NamespaceRegistry } from './namespaces.js';
import { handleRestRequest } from './rest.js';

describe('REST Control Endpoints', () => {
  let httpServer: HttpServer;
  let registry: NamespaceRegistry;
  let port: number;

  beforeEach(async () => {
    registry = new NamespaceRegistry();

    httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      const handled = await handleRestRequest(req, res, registry, false);
      if (!handled) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    port = (httpServer.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  function url(path: string): string {
    return `http://localhost:${port}${path}`;
  }

  async function post(path: string, body: Record<string, unknown>, headers?: Record<string, string>): Promise<{ status: number; data: Record<string, unknown> }> {
    const res = await fetch(url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const data = await res.json() as Record<string, unknown>;
    return { status: res.status, data };
  }

  async function get(path: string, headers?: Record<string, string>): Promise<{ status: number; data: Record<string, unknown> }> {
    const res = await fetch(url(path), {
      method: 'GET',
      headers: { ...headers },
    });
    const data = await res.json() as Record<string, unknown>;
    return { status: res.status, data };
  }

  // ─── POST /api/control/halt ────────────────────────────────

  describe('POST /api/control/halt', () => {
    it('returns 400 when reason is missing', async () => {
      const { status, data } = await post('/api/control/halt', {});
      expect(status).toBe(400);
      expect(data.error).toBe('Missing required field: reason');
    });

    it('halts the entire protocol (no target)', async () => {
      const { status, data } = await post('/api/control/halt', {
        reason: 'work complete',
        agentId: 'agent_1',
      });
      expect(status).toBe(200);
      expect(data.halted).toBe(true);
      expect(data.info).toBeDefined();
      const info = data.info as Record<string, unknown>;
      expect(info.halted).toBe(true);
      expect(info.reason).toBe('work complete');
      expect(info.status).toBe('completed');
      expect(info.haltedBy).toBe('agent_1');
    });

    it('halts with a custom status (failed)', async () => {
      const { data } = await post('/api/control/halt', {
        reason: 'unrecoverable error',
        status: 'failed',
        agentId: 'agent_1',
      });
      expect(data.halted).toBe(true);
      const info = data.info as Record<string, unknown>;
      expect(info.status).toBe('failed');
    });

    it('halts a specific agent (target)', async () => {
      const { data } = await post('/api/control/halt', {
        reason: 'agent misbehaving',
        target: 'agent_2',
        agentId: 'supervisor',
      });
      expect(data.halted).toBe(true);
      const info = data.info as Record<string, unknown>;
      expect(info.reason).toBe('agent misbehaving');
      expect(info.haltedBy).toBe('supervisor');
    });

    it('auto-releases claims owned by the target agent', async () => {
      const stores = registry.get('default');
      await stores.claims.claim('file:a.ts', 'editing', 'agent_2');
      await stores.claims.claim('file:b.ts', 'editing', 'agent_2');
      await stores.claims.claim('file:c.ts', 'editing', 'agent_3');

      await post('/api/control/halt', {
        reason: 'removing agent_2',
        target: 'agent_2',
        agentId: 'supervisor',
      });

      const claims = await stores.claims.list();
      const agent2Claims = claims.filter(c => c.owner === 'agent_2' && c.status === 'active');
      expect(agent2Claims).toHaveLength(0);

      // agent_3's claim should be untouched
      const agent3Claims = claims.filter(c => c.owner === 'agent_3' && c.status === 'active');
      expect(agent3Claims).toHaveLength(1);
    });

    it('removes the target agent role on halt', async () => {
      const stores = registry.get('default');
      await stores.roles.assign('agent_2', 'worker');

      await post('/api/control/halt', {
        reason: 'done with agent_2',
        target: 'agent_2',
        agentId: 'supervisor',
      });

      const assignment = await stores.roles.getByAgent('agent_2');
      expect(assignment).toBeNull();
    });

    it('publishes agent.halted event for targeted halt', async () => {
      await post('/api/control/halt', {
        reason: 'shutdown agent_2',
        target: 'agent_2',
        agentId: 'supervisor',
      });

      const stores = registry.get('default');
      const { events } = await stores.events.getEvents(undefined, 'honeybee.agent.halted');
      expect(events).toHaveLength(1);
      const eventData = events[0].data as Record<string, unknown>;
      expect(eventData.agent).toBe('agent_2');
      expect(eventData.reason).toBe('shutdown agent_2');
      expect(eventData.halted_by).toBe('supervisor');
    });

    it('publishes protocol.halt event for protocol-wide halt', async () => {
      await post('/api/control/halt', {
        reason: 'all done',
        agentId: 'coordinator',
      });

      const stores = registry.get('default');
      const { events } = await stores.events.getEvents(undefined, 'protocol.halt');
      expect(events).toHaveLength(1);
      const eventData = events[0].data as Record<string, unknown>;
      expect(eventData.reason).toBe('all done');
      expect(eventData.halted_by).toBe('coordinator');
    });

    it('uses X-Agent-Id header when agentId not in body', async () => {
      const { data } = await post('/api/control/halt', {
        reason: 'header test',
      }, { 'X-Agent-Id': 'header_agent' });
      const info = data.info as Record<string, unknown>;
      expect(info.haltedBy).toBe('header_agent');
    });
  });

  // ─── POST /api/control/pause ───────────────────────────────

  describe('POST /api/control/pause', () => {
    it('returns 400 when reason is missing', async () => {
      const { status, data } = await post('/api/control/pause', {});
      expect(status).toBe(400);
      expect(data.error).toBe('Missing required field: reason');
    });

    it('pauses the entire protocol (no target)', async () => {
      const { status, data } = await post('/api/control/pause', {
        reason: 'waiting for human review',
        agentId: 'coordinator',
      });
      expect(status).toBe(200);
      expect(data.paused).toBe(true);
      const info = data.info as Record<string, unknown>;
      expect(info.paused).toBe(true);
      expect(info.reason).toBe('waiting for human review');
      expect(info.pausedBy).toBe('coordinator');
    });

    it('pauses a specific agent', async () => {
      const { data } = await post('/api/control/pause', {
        reason: 'rate limited',
        target: 'agent_1',
        agentId: 'supervisor',
      });
      expect(data.paused).toBe(true);
      const info = data.info as Record<string, unknown>;
      expect(info.reason).toBe('rate limited');
      expect(info.pausedBy).toBe('supervisor');
    });

    it('publishes protocol.paused event for protocol-wide pause', async () => {
      await post('/api/control/pause', {
        reason: 'sync point',
        agentId: 'coordinator',
      });

      const stores = registry.get('default');
      const { events } = await stores.events.getEvents(undefined, 'protocol.paused');
      expect(events).toHaveLength(1);
      const eventData = events[0].data as Record<string, unknown>;
      expect(eventData.reason).toBe('sync point');
    });

    it('publishes agent.paused event for targeted pause', async () => {
      await post('/api/control/pause', {
        reason: 'too fast',
        target: 'agent_1',
        agentId: 'supervisor',
      });

      const stores = registry.get('default');
      const { events } = await stores.events.getEvents(undefined, 'honeybee.agent.paused');
      expect(events).toHaveLength(1);
      const eventData = events[0].data as Record<string, unknown>;
      expect(eventData.agent).toBe('agent_1');
    });
  });

  // ─── POST /api/control/resume ──────────────────────────────

  describe('POST /api/control/resume', () => {
    it('returns 400 when reason is missing', async () => {
      const { status, data } = await post('/api/control/resume', {});
      expect(status).toBe(400);
      expect(data.error).toBe('Missing required field: reason');
    });

    it('resumes a paused protocol', async () => {
      await post('/api/control/pause', {
        reason: 'review needed',
        agentId: 'coordinator',
      });

      const { status, data } = await post('/api/control/resume', {
        reason: 'review complete',
        agentId: 'coordinator',
      });
      expect(status).toBe(200);
      expect(data.resumed).toBe(true);
    });

    it('resumes a paused agent', async () => {
      await post('/api/control/pause', {
        reason: 'rate limited',
        target: 'agent_1',
        agentId: 'supervisor',
      });

      const { data } = await post('/api/control/resume', {
        reason: 'rate limit lifted',
        target: 'agent_1',
        agentId: 'supervisor',
      });
      expect(data.resumed).toBe(true);
    });

    it('returns false when protocol is not paused', async () => {
      const { data } = await post('/api/control/resume', {
        reason: 'nothing to resume',
        agentId: 'coordinator',
      });
      expect(data.resumed).toBe(false);
    });

    it('returns false when agent is not paused', async () => {
      const { data } = await post('/api/control/resume', {
        reason: 'nothing to resume',
        target: 'agent_1',
        agentId: 'supervisor',
      });
      expect(data.resumed).toBe(false);
    });

    it('publishes protocol.resumed event on success', async () => {
      await post('/api/control/pause', {
        reason: 'checkpoint',
        agentId: 'coordinator',
      });
      await post('/api/control/resume', {
        reason: 'checkpoint done',
        agentId: 'coordinator',
      });

      const stores = registry.get('default');
      const { events } = await stores.events.getEvents(undefined, 'protocol.resumed');
      expect(events).toHaveLength(1);
      const eventData = events[0].data as Record<string, unknown>;
      expect(eventData.reason).toBe('checkpoint done');
    });

    it('publishes agent.resumed event on agent resume', async () => {
      await post('/api/control/pause', {
        reason: 'hold',
        target: 'agent_1',
        agentId: 'supervisor',
      });
      await post('/api/control/resume', {
        reason: 'carry on',
        target: 'agent_1',
        agentId: 'supervisor',
      });

      const stores = registry.get('default');
      const { events } = await stores.events.getEvents(undefined, 'honeybee.agent.resumed');
      expect(events).toHaveLength(1);
      const eventData = events[0].data as Record<string, unknown>;
      expect(eventData.agent).toBe('agent_1');
      expect(eventData.reason).toBe('carry on');
    });
  });

  // ─── GET /api/control/status ───────────────────────────────

  describe('GET /api/control/status', () => {
    it('returns clean status when nothing is halted or paused', async () => {
      const { status, data } = await get('/api/control/status');
      expect(status).toBe(200);
      expect(data.halted).toBe(false);
      expect(data.paused).toBe(false);
      expect(data.haltReason).toBeUndefined();
      expect(data.pauseReason).toBeUndefined();
    });

    it('reflects protocol-wide halt', async () => {
      await post('/api/control/halt', {
        reason: 'all finished',
        agentId: 'coordinator',
      });

      const { data } = await get('/api/control/status');
      expect(data.halted).toBe(true);
      expect(data.paused).toBe(false);
      expect(data.haltReason).toBe('all finished');
      expect(data.haltStatus).toBe('completed');
    });

    it('reflects protocol-wide pause', async () => {
      await post('/api/control/pause', {
        reason: 'waiting for input',
        agentId: 'coordinator',
      });

      const { data } = await get('/api/control/status');
      expect(data.halted).toBe(false);
      expect(data.paused).toBe(true);
      expect(data.pauseReason).toBe('waiting for input');
    });

    it('returns agent-specific halt via agentId query param', async () => {
      await post('/api/control/halt', {
        reason: 'agent_1 misbehaved',
        target: 'agent_1',
        agentId: 'supervisor',
      });

      const { data } = await get('/api/control/status?agentId=agent_1');
      expect(data.halted).toBe(true);
      expect(data.haltReason).toBe('agent_1 misbehaved');

      // Another agent should not be halted
      const { data: data2 } = await get('/api/control/status?agentId=agent_2');
      expect(data2.halted).toBe(false);
      expect(data2.paused).toBe(false);
    });

    it('returns agent-specific pause via agentId query param', async () => {
      await post('/api/control/pause', {
        reason: 'throttled',
        target: 'agent_1',
        agentId: 'supervisor',
      });

      const { data } = await get('/api/control/status?agentId=agent_1');
      expect(data.paused).toBe(true);
      expect(data.pauseReason).toBe('throttled');

      // Another agent should not be paused
      const { data: data2 } = await get('/api/control/status?agentId=agent_2');
      expect(data2.paused).toBe(false);
    });

    it('returns agent-specific halt via X-Agent-Id header', async () => {
      await post('/api/control/halt', {
        reason: 'agent_1 misbehaved',
        target: 'agent_1',
        agentId: 'supervisor',
      });

      const { data } = await get('/api/control/status', { 'X-Agent-Id': 'agent_1' });
      expect(data.halted).toBe(true);
      expect(data.haltReason).toBe('agent_1 misbehaved');

      // Another agent via header should not be halted
      const { data: data2 } = await get('/api/control/status', { 'X-Agent-Id': 'agent_2' });
      expect(data2.halted).toBe(false);
      expect(data2.paused).toBe(false);
    });

    it('returns agent-specific pause via X-Agent-Id header', async () => {
      await post('/api/control/pause', {
        reason: 'throttled',
        target: 'agent_1',
        agentId: 'supervisor',
      });

      const { data } = await get('/api/control/status', { 'X-Agent-Id': 'agent_1' });
      expect(data.paused).toBe(true);
      expect(data.pauseReason).toBe('throttled');
    });

    it('query param takes priority over X-Agent-Id header', async () => {
      await post('/api/control/halt', {
        reason: 'agent_1 halted',
        target: 'agent_1',
        agentId: 'supervisor',
      });

      // Query param says agent_2 (not halted), header says agent_1 (halted)
      const { data } = await get('/api/control/status?agentId=agent_2', { 'X-Agent-Id': 'agent_1' });
      expect(data.halted).toBe(false);
    });

    it('protocol halt takes priority over agent pause', async () => {
      await post('/api/control/pause', {
        reason: 'agent throttled',
        target: 'agent_1',
        agentId: 'supervisor',
      });
      await post('/api/control/halt', {
        reason: 'protocol finished',
        agentId: 'coordinator',
      });

      const { data } = await get('/api/control/status?agentId=agent_1');
      expect(data.halted).toBe(true);
      expect(data.paused).toBe(false);
      expect(data.haltReason).toBe('protocol finished');
    });

    it('status clears after resume', async () => {
      await post('/api/control/pause', {
        reason: 'hold',
        agentId: 'coordinator',
      });
      await post('/api/control/resume', {
        reason: 'go',
        agentId: 'coordinator',
      });

      const { data } = await get('/api/control/status');
      expect(data.halted).toBe(false);
      expect(data.paused).toBe(false);
    });
  });
});
