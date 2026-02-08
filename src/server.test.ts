import { describe, it, expect, beforeEach } from 'vitest';
import { createServer, createStores } from './server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

describe('MCP Server Integration', () => {
  let client: Client;

  beforeEach(async () => {
    const stores = createStores();
    const server = createServer(stores, { agentId: 'test_agent' });
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

  it('lists all 16 tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(16);
    const names = tools.map(t => t.name);
    expect(names).toContain('incubator_getState');
    expect(names).toContain('incubator_setState');
    expect(names).toContain('incubator_queryState');
    expect(names).toContain('incubator_deleteState');
    expect(names).toContain('incubator_claim');
    expect(names).toContain('incubator_releaseClaim');
    expect(names).toContain('incubator_checkClaim');
    expect(names).toContain('incubator_listClaims');
    expect(names).toContain('incubator_publishEvent');
    expect(names).toContain('incubator_getEvents');
    expect(names).toContain('incubator_publishDiscovery');
    expect(names).toContain('incubator_searchDiscoveries');
    expect(names).toContain('incubator_getProtocol');
  });

  // State tools
  it('setState and getState round-trip', async () => {
    await callTool('incubator_setState', { key: 'greeting', value: 'hello' });
    const result = await callTool('incubator_getState', { key: 'greeting' });
    expect(result.found).toBe(true);
    expect(result.entry.value).toBe('hello');
  });

  it('getState returns not found for missing key', async () => {
    const result = await callTool('incubator_getState', { key: 'nope' });
    expect(result.found).toBe(false);
  });

  it('queryState by category', async () => {
    await callTool('incubator_setState', { key: 'k1', value: 'v1', category: 'config' });
    await callTool('incubator_setState', { key: 'k2', value: 'v2', category: 'progress' });
    const result = await callTool('incubator_queryState', { category: 'config' });
    expect(result.count).toBe(1);
  });

  it('deleteState removes entry', async () => {
    await callTool('incubator_setState', { key: 'temp', value: 'data' });
    const del = await callTool('incubator_deleteState', { key: 'temp' });
    expect(del.deleted).toBe(true);
    const get = await callTool('incubator_getState', { key: 'temp' });
    expect(get.found).toBe(false);
  });

  // Claim tools
  it('claim and release flow', async () => {
    const claim = await callTool('incubator_claim', { resource: 'file.ts', value: 'editing' });
    expect(claim.status).toBe('approved');

    const check = await callTool('incubator_checkClaim', { resource: 'file.ts' });
    expect(check.claimed).toBe(true);

    const release = await callTool('incubator_releaseClaim', { resource: 'file.ts' });
    expect(release.released).toBe(true);
  });

  it('listClaims returns active claims', async () => {
    await callTool('incubator_claim', { resource: 'a.ts', value: 'x' });
    await callTool('incubator_claim', { resource: 'b.ts', value: 'y' });
    const list = await callTool('incubator_listClaims', {});
    expect(list.count).toBe(2);
  });

  // Event tools
  it('publishEvent and getEvents', async () => {
    await callTool('incubator_publishEvent', { type: 'conflict', data: { file: 'a.ts' } });
    await callTool('incubator_publishEvent', { type: 'completed', data: { file: 'b.ts' } });
    const result = await callTool('incubator_getEvents', {});
    // Includes claim events from other tests in same server, but at minimum our 2
    expect(result.events.length).toBeGreaterThanOrEqual(2);
    expect(result.cursor).toBeGreaterThan(0);
  });

  it('getEvents with since cursor', async () => {
    await callTool('incubator_publishEvent', { type: 'a', data: {} });
    const first = await callTool('incubator_getEvents', {});
    await callTool('incubator_publishEvent', { type: 'b', data: {} });
    const second = await callTool('incubator_getEvents', { since: first.cursor });
    expect(second.events.length).toBe(1);
    expect(second.events[0].type).toBe('b');
  });

  // Discovery tools
  it('publishDiscovery and searchDiscoveries', async () => {
    await callTool('incubator_publishDiscovery', {
      topic: 'naming convention',
      content: 'All variables use camelCase',
      category: 'naming',
    });
    const result = await callTool('incubator_searchDiscoveries', { query: 'camelCase' });
    expect(result.count).toBe(1);
    expect(result.discoveries[0].topic).toBe('naming convention');
  });
});
