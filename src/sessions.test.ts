import { describe, it, expect, beforeEach } from 'vitest';
import { SessionStore } from './sessions.js';

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  it('registers an agent and returns a token', () => {
    const token = store.register('agent-1', 'worker');
    expect(token).toBeTypeOf('string');
    expect(token.length).toBe(48); // 24 bytes hex = 48 chars
  });

  it('returns the same token for duplicate registration', () => {
    const token1 = store.register('agent-1', 'worker');
    const token2 = store.register('agent-1', 'leader');
    expect(token1).toBe(token2);
  });

  it('generates unique tokens for different agents', () => {
    const token1 = store.register('agent-1');
    const token2 = store.register('agent-2');
    expect(token1).not.toBe(token2);
  });

  it('verifies a valid token', () => {
    const token = store.register('agent-1', 'worker');
    expect(store.verify(token)).toBe('agent-1');
  });

  it('returns null for invalid token', () => {
    expect(store.verify('bogus')).toBeNull();
  });

  it('isRegistered returns true for registered agents', () => {
    store.register('agent-1');
    expect(store.isRegistered('agent-1')).toBe(true);
    expect(store.isRegistered('agent-2')).toBe(false);
  });

  it('revokes a session', () => {
    const token = store.register('agent-1');
    expect(store.revoke('agent-1')).toBe(true);
    expect(store.verify(token)).toBeNull();
    expect(store.isRegistered('agent-1')).toBe(false);
  });

  it('revoke returns false for unregistered agent', () => {
    expect(store.revoke('ghost')).toBe(false);
  });

  it('clears all sessions', () => {
    const t1 = store.register('agent-1');
    const t2 = store.register('agent-2');
    store.clear();
    expect(store.verify(t1)).toBeNull();
    expect(store.verify(t2)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('tracks size correctly', () => {
    expect(store.size).toBe(0);
    store.register('a');
    store.register('b');
    expect(store.size).toBe(2);
    store.revoke('a');
    expect(store.size).toBe(1);
  });
});
