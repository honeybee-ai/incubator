import { describe, it, expect } from 'vitest';
import { scanInput } from './guard.js';
import type { Guard } from './guard.js';

function createMockGuard(action: 'PASS' | 'BLOCK' | 'WARN'): Guard {
  return {
    scan: (message: string) => ({
      pass: action === 'PASS',
      score: action === 'BLOCK' ? 100 : action === 'WARN' ? 50 : 0,
      action,
      findings: action !== 'PASS' ? [{ category: 'test', severity: 'high', description: 'test finding' }] : [],
      summary: action === 'BLOCK' ? 'Prompt injection detected' : 'OK',
    }),
  };
}

describe('scanInput', () => {
  it('returns null when guard is null', () => {
    expect(scanInput(null, ['hello'])).toBeNull();
  });

  it('returns null for clean input', () => {
    const guard = createMockGuard('PASS');
    expect(scanInput(guard, ['hello', 'world'])).toBeNull();
  });

  it('returns error message on BLOCK', () => {
    const guard = createMockGuard('BLOCK');
    const result = scanInput(guard, ['malicious input']);
    expect(result).toContain('Blocked by security policy');
  });

  it('returns null on WARN (not blocked)', () => {
    const guard = createMockGuard('WARN');
    expect(scanInput(guard, ['suspicious input'])).toBeNull();
  });

  it('returns null for empty fields', () => {
    const guard = createMockGuard('BLOCK');
    expect(scanInput(guard, [undefined, undefined])).toBeNull();
    expect(scanInput(guard, [])).toBeNull();
  });
});
