import { describe, it, expect, vi, afterEach } from 'vitest';
import { TOOL_DEFS, executeToolCall } from './tools.js';
import type { ToolCall } from './types.js';

describe('TOOL_DEFS', () => {
  const expectedTools = [
    'incubator_getState',
    'incubator_setState',
    'incubator_queryState',
    'incubator_deleteState',
    'incubator_claim',
    'incubator_releaseClaim',
    'incubator_checkClaim',
    'incubator_listClaims',
    'incubator_publishEvent',
    'incubator_getEvents',
    'incubator_publishDiscovery',
    'incubator_searchDiscoveries',
    'incubator_getProtocol',
    'incubator_sendMessage',
    'incubator_getMessages',
    'incubator_requestRole',
    'incubator_requestHelp',
    'incubator_claimHelp',
    'incubator_reportProgress',
    'incubator_flagConflict',
    'incubator_requestReinforcement',
    'incubator_requestApproval',
    'incubator_escalate',
    'incubator_proposeAction',
    'incubator_endorseAction',
    'incubator_requestRollback',
    'incubator_requestHalt',
    'incubator_requestPause',
    'incubator_resumeAgent',
  ];

  it('defines all 29 tools', () => {
    expect(TOOL_DEFS).toHaveLength(29);
  });

  it('has correct tool names', () => {
    const names = TOOL_DEFS.map(t => t.function.name);
    expect(names).toEqual(expectedTools);
  });

  it('all tools have type "function"', () => {
    for (const tool of TOOL_DEFS) {
      expect(tool.type).toBe('function');
    }
  });

  it('all tools have description and parameters', () => {
    for (const tool of TOOL_DEFS) {
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters.type).toBe('object');
      expect(tool.function.parameters.properties).toBeDefined();
      expect(Array.isArray(tool.function.parameters.required)).toBe(true);
    }
  });

  it('property definitions have type and description', () => {
    for (const tool of TOOL_DEFS) {
      for (const [, prop] of Object.entries(tool.function.parameters.properties)) {
        expect(prop.type).toBeTruthy();
        expect(prop.description).toBeTruthy();
      }
    }
  });
});

describe('executeToolCall', () => {
  const serverUrl = 'http://localhost:3100';
  const agentId = 'test_agent';

  afterEach(() => { vi.restoreAllMocks(); });

  function tc(name: string, args: Record<string, unknown>): ToolCall {
    return { id: 'call_1', type: 'function', function: { name, arguments: args } };
  }

  it('maps getState to GET /api/state/:key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ text: async () => '{"found":true}' });
    vi.stubGlobal('fetch', fetchMock);

    await executeToolCall(tc('incubator_getState', { key: 'phase' }), agentId, serverUrl);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3100/api/state/phase');
    expect(init.method).toBe('GET');
  });

  it('maps setState to PUT /api/state/:key with body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ text: async () => '{"success":true}' });
    vi.stubGlobal('fetch', fetchMock);

    await executeToolCall(tc('incubator_setState', { key: 'phase', value: 'trading' }), agentId, serverUrl);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3100/api/state/phase');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ value: 'trading', category: undefined, ttlMs: undefined });
  });

  it('maps queryState to GET /api/state with query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ text: async () => '{"count":0}' });
    vi.stubGlobal('fetch', fetchMock);

    await executeToolCall(tc('incubator_queryState', { pattern: 'agent_*', category: 'config' }), agentId, serverUrl);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/state?');
    expect(url).toContain('pattern=agent_');
    expect(url).toContain('category=config');
  });

  it('maps claim to POST /api/claims', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ text: async () => '{"status":"approved"}' });
    vi.stubGlobal('fetch', fetchMock);

    await executeToolCall(tc('incubator_claim', { resource: 'file:main.ts', value: 'editing' }), agentId, serverUrl);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3100/api/claims');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ resource: 'file:main.ts', value: 'editing', ttlMs: undefined });
  });

  it('maps releaseClaim to DELETE /api/claims/:resource', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ text: async () => '{"released":true}' });
    vi.stubGlobal('fetch', fetchMock);

    await executeToolCall(tc('incubator_releaseClaim', { resource: 'file:main.ts' }), agentId, serverUrl);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3100/api/claims/file%3Amain.ts');
    expect(init.method).toBe('DELETE');
  });

  it('maps getEvents to GET /api/events with query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ text: async () => '{"events":[]}' });
    vi.stubGlobal('fetch', fetchMock);

    await executeToolCall(tc('incubator_getEvents', { since: 5, type: 'conflict' }), agentId, serverUrl);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/events?');
    expect(url).toContain('since=5');
    expect(url).toContain('type=conflict');
  });

  it('maps getProtocol to GET /api/protocol', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ text: async () => '{"loaded":true}' });
    vi.stubGlobal('fetch', fetchMock);

    await executeToolCall(tc('incubator_getProtocol', { role: 'trader' }), agentId, serverUrl);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/protocol?');
    expect(url).toContain('role=trader');
  });

  it('passes X-Agent-Id header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ text: async () => '{}' });
    vi.stubGlobal('fetch', fetchMock);

    await executeToolCall(tc('incubator_getState', { key: 'test' }), 'my_agent', serverUrl);
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['X-Agent-Id']).toBe('my_agent');
  });

  it('returns result as string', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: async () => '{"found":true,"entry":{"key":"x","value":42}}',
    }));

    const result = await executeToolCall(tc('incubator_getState', { key: 'x' }), agentId, serverUrl);
    expect(typeof result).toBe('string');
    expect(JSON.parse(result)).toEqual({ found: true, entry: { key: 'x', value: 42 } });
  });

  it('returns error JSON for unknown tools', async () => {
    const result = await executeToolCall(tc('unknown_tool', {}), agentId, serverUrl);
    expect(JSON.parse(result)).toEqual({ error: 'Unknown tool: unknown_tool' });
  });

  it('returns error JSON on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await executeToolCall(tc('incubator_getState', { key: 'x' }), agentId, serverUrl);
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('REST call failed');
  });
});
