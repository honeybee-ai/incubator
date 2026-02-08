import { describe, it, expect } from 'vitest';
import { NamespaceRegistry } from './namespaces.js';

describe('NamespaceRegistry', () => {
  it('creates stores on first access', () => {
    const registry = new NamespaceRegistry();
    const stores = registry.get('team-a');
    expect(stores).toBeDefined();
    expect(stores.state).toBeDefined();
    expect(stores.claims).toBeDefined();
    expect(stores.events).toBeDefined();
    expect(stores.discoveries).toBeDefined();
  });

  it('returns same stores on subsequent access', () => {
    const registry = new NamespaceRegistry();
    const first = registry.get('team-a');
    const second = registry.get('team-a');
    expect(first).toBe(second);
  });

  it('isolates namespaces from each other', async () => {
    const registry = new NamespaceRegistry();
    const a = registry.get('ns-a');
    const b = registry.get('ns-b');

    await a.state.set('key', 'a-value', 'agent_1');
    expect((await a.state.get('key'))?.value).toBe('a-value');
    expect(await b.state.get('key')).toBeNull();
  });

  it('uses default namespace when no namespace specified', async () => {
    const registry = new NamespaceRegistry();
    const stores = registry.get('default');
    await stores.state.set('key', 'value', 'agent_1');
    expect((await registry.get('default').state.get('key'))?.value).toBe('value');
  });

  it('lists all active namespaces', () => {
    const registry = new NamespaceRegistry();
    registry.get('alpha');
    registry.get('beta');
    registry.get('gamma');
    expect(registry.list().sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('deletes a namespace and its data', async () => {
    const registry = new NamespaceRegistry();
    const stores = registry.get('temp');
    await stores.state.set('key', 'value', 'agent_1');

    expect(registry.delete('temp')).toBe(true);
    expect(registry.list()).not.toContain('temp');

    // Re-accessing creates fresh stores
    const fresh = registry.get('temp');
    expect(await fresh.state.get('key')).toBeNull();
  });

  it('delete returns false for non-existent namespace', () => {
    const registry = new NamespaceRegistry();
    expect(registry.delete('nope')).toBe(false);
  });

  it('rejects _ns as namespace name', () => {
    const registry = new NamespaceRegistry();
    expect(() => registry.get('_ns')).toThrow("'_ns' is a reserved name");
  });

  it('has() reports namespace existence', () => {
    const registry = new NamespaceRegistry();
    expect(registry.has('team-a')).toBe(false);
    registry.get('team-a');
    expect(registry.has('team-a')).toBe(true);
  });
});
