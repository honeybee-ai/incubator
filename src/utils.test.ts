import { describe, it, expect } from 'vitest';
import { matchGlob, generateId, isExpired } from './utils.js';

describe('matchGlob', () => {
  it('matches exact strings', () => {
    expect(matchGlob('hello', 'hello')).toBe(true);
    expect(matchGlob('hello', 'world')).toBe(false);
  });

  it('matches * wildcard', () => {
    expect(matchGlob('agent_*', 'agent_1')).toBe(true);
    expect(matchGlob('agent_*', 'agent_foo')).toBe(true);
    expect(matchGlob('agent_*', 'other_1')).toBe(false);
    expect(matchGlob('*.ts', 'file.ts')).toBe(true);
    expect(matchGlob('*.ts', 'file.js')).toBe(false);
  });

  it('matches ? wildcard', () => {
    expect(matchGlob('agent_?', 'agent_1')).toBe(true);
    expect(matchGlob('agent_?', 'agent_12')).toBe(false);
  });

  it('handles special regex chars', () => {
    expect(matchGlob('file.ts', 'file.ts')).toBe(true);
    expect(matchGlob('file.ts', 'filexts')).toBe(false);
  });
});

describe('generateId', () => {
  it('generates unique IDs', () => {
    const a = generateId();
    const b = generateId();
    expect(a).not.toBe(b);
  });
});

describe('isExpired', () => {
  it('returns false when no TTL', () => {
    expect(isExpired(new Date().toISOString())).toBe(false);
  });

  it('returns false when within TTL', () => {
    expect(isExpired(new Date().toISOString(), 60000)).toBe(false);
  });

  it('returns true when past TTL', () => {
    const past = new Date(Date.now() - 10000).toISOString();
    expect(isExpired(past, 5000)).toBe(true);
  });
});
