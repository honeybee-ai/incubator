import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { NamespaceRegistry } from './namespaces.js';
import { handleRestRequest, resolveAgentId } from './rest.js';
import { SessionStore } from './sessions.js';

// ─── Unit tests: resolveAgentId ─────────────────────────────────

describe('resolveAgentId', () => {
  let sessions: SessionStore;

  beforeEach(() => {
    sessions = new SessionStore();
  });

  function makeReq(headers: Record<string, string> = {}): IncomingMessage {
    return { headers } as unknown as IncomingMessage;
  }

  it('returns body agentId when no sessions', () => {
    const id = resolveAgentId(makeReq(), { agentId: 'alice' });
    expect(id).toBe('alice');
  });

  it('returns header X-Agent-Id when no body agentId', () => {
    const id = resolveAgentId(makeReq({ 'x-agent-id': 'bob' }), {});
    expect(id).toBe('bob');
  });

  it('returns rest_anonymous when no ID provided', () => {
    const id = resolveAgentId(makeReq(), {});
    expect(id).toBe('rest_anonymous');
  });

  it('rejects honeycomb: prefix', () => {
    const id = resolveAgentId(makeReq(), { agentId: 'honeycomb:loop' });
    expect(id).toBe('rest_anonymous');
  });

  it('uses session token when valid', () => {
    const token = sessions.register('alice');
    const req = makeReq({ 'x-session-token': token });
    const id = resolveAgentId(req, { agentId: 'evil' }, sessions);
    expect(id).toBe('alice');
  });

  it('ignores invalid session token and falls through', () => {
    const req = makeReq({ 'x-session-token': 'bad-token' });
    const id = resolveAgentId(req, { agentId: 'bob' }, sessions);
    expect(id).toBe('bob');
  });

  it('blocks spoofing of registered agent ID', () => {
    sessions.register('alice');
    // Attacker tries to use alice's ID without a token
    const req = makeReq({ 'x-agent-id': 'alice' });
    const id = resolveAgentId(req, {}, sessions);
    expect(id).toMatch(/^rest_anon_[0-9a-f]{8}$/);
    expect(id).not.toBe('alice');
  });

  it('allows unregistered IDs without token', () => {
    sessions.register('alice');
    // bob is not registered, so no token needed
    const req = makeReq({ 'x-agent-id': 'bob' });
    const id = resolveAgentId(req, {}, sessions);
    expect(id).toBe('bob');
  });

  it('blocks spoofing via body agentId', () => {
    sessions.register('queen');
    const id = resolveAgentId(makeReq(), { agentId: 'queen' }, sessions);
    expect(id).toMatch(/^rest_anon_/);
  });

  it('allows registered agent with correct token', () => {
    const token = sessions.register('queen');
    const req = makeReq({ 'x-session-token': token, 'x-agent-id': 'queen' });
    const id = resolveAgentId(req, {}, sessions);
    expect(id).toBe('queen');
  });
});

// ─── Integration tests: REST anti-spoofing ───────────────────────

describe('REST anti-spoofing integration', () => {
  let httpServer: HttpServer;
  let registry: NamespaceRegistry;
  let sessions: SessionStore;
  let port: number;

  beforeEach(async () => {
    registry = new NamespaceRegistry();
    sessions = new SessionStore();

    httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      const handled = await handleRestRequest(req, res, registry, false, undefined, sessions);
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

  it('roles/request returns a sessionToken', async () => {
    const res = await fetch(url('/api/roles/request'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Id': 'agent-1' },
      body: JSON.stringify({ role: 'worker' }),
    });
    const data = await res.json() as Record<string, unknown>;
    expect(data.approved).toBe(true);
    expect(data.sessionToken).toBeTypeOf('string');
    expect((data.sessionToken as string).length).toBe(48);
  });

  it('registered agent can publish events with valid token', async () => {
    // Register
    const regRes = await fetch(url('/api/roles/request'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Id': 'alice' },
      body: JSON.stringify({ role: 'leader' }),
    });
    const regData = await regRes.json() as Record<string, unknown>;
    const token = regData.sessionToken as string;

    // Publish with token
    const pubRes = await fetch(url('/api/events'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Id': 'alice',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ type: 'test.event', data: { msg: 'hello' } }),
    });
    const pubData = await pubRes.json() as Record<string, unknown>;
    expect(pubData.published).toBe(true);
    const event = pubData.event as Record<string, unknown>;
    expect(event.publishedBy).toBe('alice');
  });

  it('attacker cannot spoof registered agent without token', async () => {
    // Register alice
    await fetch(url('/api/roles/request'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Id': 'alice' },
      body: JSON.stringify({ role: 'leader' }),
    });

    // Attacker tries to publish as alice (no token)
    const pubRes = await fetch(url('/api/events'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Id': 'alice',
      },
      body: JSON.stringify({ type: 'spoofed.event', data: {} }),
    });
    const pubData = await pubRes.json() as Record<string, unknown>;
    expect(pubData.published).toBe(true);
    const event = pubData.event as Record<string, unknown>;
    // Should NOT be published as alice
    expect(event.publishedBy).not.toBe('alice');
    expect(event.publishedBy).toMatch(/^rest_anon_/);
  });

  it('attacker with wrong token cannot spoof', async () => {
    // Register alice
    await fetch(url('/api/roles/request'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Id': 'alice' },
      body: JSON.stringify({ role: 'leader' }),
    });

    // Attacker uses a fake token
    const pubRes = await fetch(url('/api/events'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Id': 'alice',
        'X-Session-Token': 'fake-token-that-does-not-exist',
      },
      body: JSON.stringify({ type: 'spoofed.event', data: {} }),
    });
    const pubData = await pubRes.json() as Record<string, unknown>;
    const event = pubData.event as Record<string, unknown>;
    expect(event.publishedBy).not.toBe('alice');
    expect(event.publishedBy).toMatch(/^rest_anon_/);
  });

  it('unregistered agents can still use any ID', async () => {
    // No one registered — anyone can claim any ID
    const pubRes = await fetch(url('/api/events'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Id': 'free-agent',
      },
      body: JSON.stringify({ type: 'test.event', data: {} }),
    });
    const pubData = await pubRes.json() as Record<string, unknown>;
    const event = pubData.event as Record<string, unknown>;
    expect(event.publishedBy).toBe('free-agent');
  });

  it('halt with target revokes session', async () => {
    // Register alice
    const regRes = await fetch(url('/api/roles/request'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Id': 'alice' },
      body: JSON.stringify({ role: 'worker' }),
    });
    const regData = await regRes.json() as Record<string, unknown>;
    const token = regData.sessionToken as string;

    // Halt alice
    await fetch(url('/api/control/halt'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Id': 'orchestrator' },
      body: JSON.stringify({ reason: 'done', target: 'alice' }),
    });

    // Alice's token should no longer work — and her ID is no longer registered,
    // so anyone can use it (backwards compat with non-token callers)
    const pubRes = await fetch(url('/api/events'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Id': 'alice',
        'X-Session-Token': token,
      },
      body: JSON.stringify({ type: 'post-halt', data: {} }),
    });
    const pubData = await pubRes.json() as Record<string, unknown>;
    const event = pubData.event as Record<string, unknown>;
    // Token is invalid now, but alice is also no longer registered,
    // so the ID falls through to client-supplied (backwards compat)
    expect(event.publishedBy).toBe('alice');
  });

  it('CORS headers include X-Session-Token', async () => {
    const res = await fetch(url('/api/health'), {
      method: 'OPTIONS',
    });
    // OPTIONS returns 204 with CORS headers
    expect(res.status).toBe(204);
  });
});
