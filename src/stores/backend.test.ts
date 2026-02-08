import { describe, it, expect } from 'vitest';
import { createBackend } from './backend.js';

describe('createBackend', () => {
  it('returns memory stores by default', () => {
    const stores = createBackend({ type: 'memory' });
    expect(stores.state).toBeDefined();
    expect(stores.events).toBeDefined();
    expect(stores.claims).toBeDefined();
    expect(stores.discoveries).toBeDefined();
  });

  it('memory stores work correctly', async () => {
    const stores = createBackend({ type: 'memory' });
    const entry = await stores.state.set('k', 'v', 'a1');
    expect(entry.key).toBe('k');
    expect((await stores.state.get('k'))!.value).toBe('v');
  });

  it('returns sqlite stores with valid config', () => {
    const stores = createBackend({ type: 'sqlite', dbPath: ':memory:', namespace: 'test' });
    expect(stores.state).toBeDefined();
    expect(stores.events).toBeDefined();
    expect(stores.claims).toBeDefined();
    expect(stores.discoveries).toBeDefined();
  });

  it('sqlite stores work correctly', async () => {
    const stores = createBackend({ type: 'sqlite', dbPath: ':memory:', namespace: 'test' });
    const entry = await stores.state.set('k', 'v', 'a1');
    expect(entry.key).toBe('k');
    expect((await stores.state.get('k'))!.value).toBe('v');
  });

  it('throws on sqlite without dbPath', () => {
    expect(() => createBackend({ type: 'sqlite' })).toThrow('SQLite backend requires dbPath');
  });

  it('throws on redis without redisClient', () => {
    expect(() => createBackend({ type: 'redis' })).toThrow('Redis backend requires redisClient');
  });

  it('throws on unknown backend type', () => {
    expect(() => createBackend({ type: 'unknown' as 'memory' })).toThrow('Unknown backend type');
  });
});
