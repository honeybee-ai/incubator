import { describe, it, expect, afterEach } from 'vitest';
import { unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSnapshot, loadSnapshot, saveAllSnapshots, loadAllSnapshots } from './persistence.js';
import { StateStore } from './stores/state.js';
import { ClaimStore } from './stores/claims.js';
import { EventStore } from './stores/events.js';
import { DiscoveryStore } from './stores/discoveries.js';
import { NamespaceRegistry } from './namespaces.js';

describe('Persistence', () => {
  const tmpFile = join(tmpdir(), `incubator-test-${Date.now()}.json`);

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  });

  function makeStores() {
    const events = new EventStore();
    const state = new StateStore();
    const claims = new ClaimStore(events);
    const discoveries = new DiscoveryStore(events);
    return { events, state, claims, discoveries };
  }

  it('saves and loads state', async () => {
    const stores = makeStores();
    await stores.state.set('key1', 'value1', 'agent_1', 'config');
    await stores.state.set('key2', { nested: true }, 'agent_2');
    await stores.events.publish('test', { data: 1 }, 'agent_1');
    await stores.claims.claim('file.ts', 'editing', 'agent_1');
    await stores.discoveries.publish('naming', 'camelCase', 'agent_1', 'convention');

    await saveSnapshot(tmpFile, stores);

    const stores2 = makeStores();
    const loaded = await loadSnapshot(tmpFile, stores2);
    expect(loaded).toBe(true);

    // State restored
    const entry = await stores2.state.get('key1');
    expect(entry).not.toBeNull();
    expect(entry!.value).toBe('value1');

    // Events restored
    const { events: evts, cursor } = await stores2.events.getEvents();
    expect(evts.length).toBeGreaterThanOrEqual(1);
    expect(cursor).toBeGreaterThan(0);

    // Claims restored
    const check = await stores2.claims.check('file.ts');
    expect(check).not.toBeNull();
    expect(check!.owner).toBe('agent_1');

    // Discoveries restored
    const disc = await stores2.discoveries.search('camelCase');
    expect(disc.length).toBe(1);
  });

  it('returns false for missing file', async () => {
    const stores = makeStores();
    expect(await loadSnapshot('/tmp/nonexistent.json', stores)).toBe(false);
  });
});

describe('Multi-namespace persistence', () => {
  const basePath = join(tmpdir(), `incubator-ns-test-${Date.now()}`);

  afterEach(() => {
    // Clean up any snapshot files
    try {
      const dir = tmpdir();
      const prefix = `incubator-ns-test-`;
      for (const f of readdirSync(dir)) {
        if (f.startsWith(prefix)) {
          try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  });

  it('saves and loads multiple namespaces', async () => {
    const registry = new NamespaceRegistry();
    await registry.get('alpha').state.set('key', 'alpha-val', 'agent_1');
    await registry.get('beta').state.set('key', 'beta-val', 'agent_2');
    await registry.get('beta').events.publish('test', { x: 1 }, 'agent_2');

    await saveAllSnapshots(basePath, registry);

    const registry2 = new NamespaceRegistry();
    const count = await loadAllSnapshots(basePath, registry2);
    expect(count).toBe(2);

    expect((await registry2.get('alpha').state.get('key'))?.value).toBe('alpha-val');
    expect((await registry2.get('beta').state.get('key'))?.value).toBe('beta-val');
    expect((await registry2.get('beta').events.getEvents()).cursor).toBeGreaterThan(0);
  });

  it('returns 0 for non-existent directory', async () => {
    const registry = new NamespaceRegistry();
    const count = await loadAllSnapshots('/tmp/nonexistent-dir-xyz/snap', registry);
    expect(count).toBe(0);
  });

  it('preserves namespace isolation on load', async () => {
    const registry = new NamespaceRegistry();
    await registry.get('ns-a').state.set('shared-key', 'a-value', 'agent_1');
    await registry.get('ns-b').state.set('shared-key', 'b-value', 'agent_2');

    await saveAllSnapshots(basePath, registry);

    const registry2 = new NamespaceRegistry();
    await loadAllSnapshots(basePath, registry2);

    expect((await registry2.get('ns-a').state.get('shared-key'))?.value).toBe('a-value');
    expect((await registry2.get('ns-b').state.get('shared-key'))?.value).toBe('b-value');
  });
});
