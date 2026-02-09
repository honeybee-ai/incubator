import { describe, it, expect, beforeEach } from 'vitest';
import { createServer, createStores } from './server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProtocolSpec, GetProtocolResult } from '@agentcoordinationprotocol/spec';

describe('getProtocol MCP Integration', () => {
  let client: Client;
  let spec: ProtocolSpec;

  beforeEach(async () => {
    // Load example spec
    const content = await readFile(
      join(import.meta.dirname, '../examples/monolith-split.acp.json'),
      'utf-8',
    );
    spec = JSON.parse(content);

    const stores = createStores();
    const server = createServer(stores, {
      agentId: 'test_agent',
      getProtocol: () => spec,
    });
    client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  async function callTool(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    return JSON.parse(text);
  }

  it('lists 19 tools (15 + getProtocol + 3 topic tools)', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(19);
    expect(tools.map(t => t.name)).toContain('incubator_getProtocol');
  });

  it('returns protocol info for default role', async () => {
    const result: GetProtocolResult = await callTool('incubator_getProtocol');
    expect(result.protocol.name).toBe('monolith-split');
    expect(result.protocol.title).toBe('Monolith Module Split');
    expect(result.protocol.acp).toBe('1.0');
  });

  it('returns role info for worker', async () => {
    const result: GetProtocolResult = await callTool('incubator_getProtocol', { role: 'worker' });
    expect(result.role.name).toBe('worker');
    expect(result.role.description).toContain('Extracts modules');
  });

  it('returns coordinator role when requested', async () => {
    const result: GetProtocolResult = await callTool('incubator_getProtocol', { role: 'coordinator' });
    expect(result.role.name).toBe('coordinator');
    expect(result.role.description).toContain('Monitors progress');
  });

  it('defaults to first phase (init)', async () => {
    const result: GetProtocolResult = await callTool('incubator_getProtocol');
    expect(result.current_phase).toBe('init');
  });

  it('respects phase state key for current phase', async () => {
    await callTool('incubator_setState', { key: 'phase', value: 'work' });
    const result: GetProtocolResult = await callTool('incubator_getProtocol', { role: 'worker' });
    expect(result.current_phase).toBe('work');
  });

  it('returns rules for current role/phase', async () => {
    const result: GetProtocolResult = await callTool('incubator_getProtocol', { role: 'worker' });
    expect(result.rules.length).toBeGreaterThan(0);
    expect(result.rules[0].action).toBe('getProtocol');
  });

  it('returns loop flag for work phase', async () => {
    await callTool('incubator_setState', { key: 'phase', value: 'work' });
    const result: GetProtocolResult = await callTool('incubator_getProtocol', { role: 'worker' });
    expect(result.loop).toBe(true);
  });

  it('returns resolved variables', async () => {
    const result: GetProtocolResult = await callTool('incubator_getProtocol');
    expect(result.variables.$self).toBe('test_agent');
    expect(typeof result.variables.$cursor).toBe('number');
  });

  it('returns rendered instructions as prose', async () => {
    const result: GetProtocolResult = await callTool('incubator_getProtocol', { role: 'worker' });
    expect(result.instructions).toContain('Monolith Module Split');
    expect(result.instructions).toContain('Your Role: worker');
    expect(result.instructions).toContain('Current Phase: init');
  });

  it('returns phases overview', async () => {
    const result: GetProtocolResult = await callTool('incubator_getProtocol');
    expect(result.phases.init.description).toContain('Orient');
    expect(result.phases.done.terminal).toBe(true);
  });

  it('returns error handling config', async () => {
    const result: GetProtocolResult = await callTool('incubator_getProtocol');
    expect(result.errors).toBeDefined();
    expect(result.errors!.claim_rejected?.action).toBe('skip_to_next');
  });

  it('returns resources', async () => {
    const result: GetProtocolResult = await callTool('incubator_getProtocol');
    expect(result.resources.claim_patterns).toBeDefined();
    expect(result.resources.event_types).toBeDefined();
  });

  it('errors on unknown role', async () => {
    const result = await callTool('incubator_getProtocol', { role: 'hacker' });
    expect(result.error).toContain('Unknown role');
  });
});

describe('getProtocol without spec loaded', () => {
  let client: Client;

  beforeEach(async () => {
    const stores = createStores();
    const server = createServer(stores, {
      agentId: 'test_agent',
      // No getProtocol — no spec loaded
    });
    client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  async function callTool(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    return JSON.parse(text);
  }

  it('returns error when no protocol loaded', async () => {
    const result = await callTool('incubator_getProtocol');
    expect(result.error).toContain('No protocol loaded');
  });
});
