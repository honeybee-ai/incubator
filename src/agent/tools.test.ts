import { describe, it, expect, vi } from 'vitest';
import { TOOL_DEFS, executeToolCall } from './tools.js';
import type { ToolCall } from './types.js';
import type { AcpClient } from '@agentcoordinationprotocol/sdk';
import { createMockClient } from './test-helpers.js';

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
  function tc(name: string, args: Record<string, unknown>): ToolCall {
    return { id: 'call_1', type: 'function', function: { name, arguments: args } };
  }

  const mockClient = createMockClient;

  it('maps getState to client.getStateKey()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_getState', { key: 'phase' }), client);
    expect(client.getStateKey).toHaveBeenCalledWith('phase');
  });

  it('maps setState to client.setState()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_setState', { key: 'phase', value: 'trading', category: 'config', ttlMs: 5000 }), client);
    expect(client.setState).toHaveBeenCalledWith('phase', 'trading', 'config', 5000);
  });

  it('maps queryState to client.queryState()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_queryState', { pattern: 'agent_*', category: 'config' }), client);
    expect(client.queryState).toHaveBeenCalledWith({ pattern: 'agent_*', category: 'config' });
  });

  it('maps claim to client.claim()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_claim', { resource: 'file:main.ts', value: 'editing', ttlMs: 30000 }), client);
    expect(client.claim).toHaveBeenCalledWith('file:main.ts', 'editing', { ttlMs: 30000 });
  });

  it('maps releaseClaim to client.releaseClaim()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_releaseClaim', { resource: 'file:main.ts' }), client);
    expect(client.releaseClaim).toHaveBeenCalledWith('file:main.ts');
  });

  it('maps checkClaim to client.checkClaim()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_checkClaim', { resource: 'file:main.ts' }), client);
    expect(client.checkClaim).toHaveBeenCalledWith('file:main.ts');
  });

  it('maps listClaims to client.listClaims()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_listClaims', { pattern: 'file:*' }), client);
    expect(client.listClaims).toHaveBeenCalledWith('file:*');
  });

  it('maps getEvents to client.getEvents()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_getEvents', { since: 5, type: 'conflict' }), client);
    expect(client.getEvents).toHaveBeenCalledWith(5, { type: 'conflict' });
  });

  it('maps getProtocol to client.getProtocol()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_getProtocol', { role: 'trader' }), client);
    expect(client.getProtocol).toHaveBeenCalledWith('trader');
  });

  it('maps sendMessage to client.sendMessage()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_sendMessage', { to: 'agent_2', content: 'hello', replyTo: 'msg_1' }), client);
    expect(client.sendMessage).toHaveBeenCalledWith('agent_2', 'hello', { replyTo: 'msg_1' });
  });

  it('maps requestRole to client.requestRole()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_requestRole', { role: 'admin', reason: 'promotion' }), client);
    expect(client.requestRole).toHaveBeenCalledWith('admin', { reason: 'promotion' });
  });

  it('maps flagConflict to client.flagConflict()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_flagConflict', { discovery_a: 'd1', discovery_b: 'd2', reason: 'contradicts' }), client);
    expect(client.flagConflict).toHaveBeenCalledWith('d1', 'd2', 'contradicts');
  });

  it('maps requestReinforcement to client.requestReinforcement()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_requestReinforcement', { role: 'worker', count: 3, reason: 'overloaded' }), client);
    expect(client.requestReinforcement).toHaveBeenCalledWith('worker', { count: 3, reason: 'overloaded' });
  });

  it('maps requestApproval to client.requestApproval()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_requestApproval', { action: 'deploy', detail: 'prod', files: 'app.js' }), client);
    expect(client.requestApproval).toHaveBeenCalledWith('deploy', { detail: 'prod', files: 'app.js' });
  });

  it('maps escalate to client.escalate()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_escalate', { reason: 'stuck', context: 'tried 3 times' }), client);
    expect(client.escalate).toHaveBeenCalledWith('stuck', 'tried 3 times');
  });

  it('maps proposeAction to client.proposeAction()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_proposeAction', { action: 'refactor', detail: 'split module', requires_quorum: 3 }), client);
    expect(client.proposeAction).toHaveBeenCalledWith('refactor', { detail: 'split module', requires_quorum: 3 });
  });

  it('maps endorseAction to client.endorseAction()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_endorseAction', { proposalId: 'prop_1' }), client);
    expect(client.endorseAction).toHaveBeenCalledWith('prop_1');
  });

  it('maps requestRollback to client.requestRollback()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_requestRollback', { reason: 'regression', scope: 'file:app.ts' }), client);
    expect(client.requestRollback).toHaveBeenCalledWith('regression', 'file:app.ts');
  });

  it('maps requestHalt to client.halt()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_requestHalt', { reason: 'done', status: 'completed', target: 'agent_2' }), client);
    expect(client.halt).toHaveBeenCalledWith('done', { status: 'completed', target: 'agent_2' });
  });

  it('maps requestPause to client.pause()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_requestPause', { reason: 'throttle', target: 'agent_1' }), client);
    expect(client.pause).toHaveBeenCalledWith('throttle', { target: 'agent_1' });
  });

  it('maps resumeAgent to client.resume()', async () => {
    const client = mockClient();
    await executeToolCall(tc('incubator_resumeAgent', { reason: 'ready', target: 'agent_1' }), client);
    expect(client.resume).toHaveBeenCalledWith({ reason: 'ready', target: 'agent_1' });
  });

  it('returns result as string', async () => {
    const client = mockClient({
      getStateKey: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { found: true, entry: { key: 'x', value: 42 } } }),
    } as Partial<AcpClient>);

    const result = await executeToolCall(tc('incubator_getState', { key: 'x' }), client);
    expect(typeof result).toBe('string');
    expect(JSON.parse(result)).toEqual({ found: true, entry: { key: 'x', value: 42 } });
  });

  it('returns error JSON for unknown tools', async () => {
    const client = mockClient();
    const result = await executeToolCall(tc('unknown_tool', {}), client);
    expect(JSON.parse(result)).toEqual({ error: 'SDK call failed: Unknown tool: unknown_tool' });
  });

  it('returns error JSON on SDK failure', async () => {
    const client = mockClient({
      getStateKey: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as Partial<AcpClient>);

    const result = await executeToolCall(tc('incubator_getState', { key: 'x' }), client);
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain('SDK call failed');
  });
});
