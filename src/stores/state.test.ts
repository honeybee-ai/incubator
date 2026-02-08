import { describe, it, expect } from 'vitest';
import { StateStore } from './state.js';

describe('StateStore', () => {
  it('sets and gets values', async () => {
    const store = new StateStore();
    await store.set('key1', 'value1', 'agent_1');
    const entry = await store.get('key1');
    expect(entry).not.toBeNull();
    expect(entry!.value).toBe('value1');
    expect(entry!.setBy).toBe('agent_1');
  });

  it('returns null for missing keys', async () => {
    const store = new StateStore();
    expect(await store.get('missing')).toBeNull();
  });

  it('overwrites with last-writer-wins', async () => {
    const store = new StateStore();
    await store.set('key1', 'v1', 'agent_1');
    await store.set('key1', 'v2', 'agent_2');
    const entry = await store.get('key1');
    expect(entry!.value).toBe('v2');
    expect(entry!.setBy).toBe('agent_2');
  });

  it('preserves original setAt on update', async () => {
    const store = new StateStore();
    await store.set('key1', 'v1', 'agent_1');
    const original = (await store.get('key1'))!.setAt;
    await store.set('key1', 'v2', 'agent_2');
    expect((await store.get('key1'))!.setAt).toBe(original);
  });

  it('deletes values', async () => {
    const store = new StateStore();
    await store.set('key1', 'v1', 'agent_1');
    expect(await store.delete('key1')).toBe(true);
    expect(await store.get('key1')).toBeNull();
    expect(await store.delete('key1')).toBe(false);
  });

  it('queries by pattern', async () => {
    const store = new StateStore();
    await store.set('agent_1.status', 'running', 'agent_1');
    await store.set('agent_2.status', 'idle', 'agent_2');
    await store.set('config.timeout', 5000, 'agent_1');
    const results = await store.query('agent_*');
    expect(results.length).toBe(2);
  });

  it('queries by category', async () => {
    const store = new StateStore();
    await store.set('k1', 'v1', 'a', 'config');
    await store.set('k2', 'v2', 'a', 'progress');
    await store.set('k3', 'v3', 'a', 'config');
    const results = await store.query(undefined, 'config');
    expect(results.length).toBe(2);
  });

  it('expires entries with TTL', async () => {
    const store = new StateStore();
    // Set with 1ms TTL
    await store.set('temp', 'value', 'agent_1', undefined, 1);
    // Wait a tiny bit
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    expect(await store.get('temp')).toBeNull();
  });
});
