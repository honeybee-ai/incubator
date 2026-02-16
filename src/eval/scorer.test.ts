import { describe, it, expect } from 'vitest';
import { computeScore } from './scorer.js';
import type { EvalCheckResult } from './types.js';

function makeCheck(name: string, score: number, weight: number): EvalCheckResult {
  return {
    name,
    passed: score >= 0.5,
    score,
    weight,
    details: '',
    duration_ms: 0,
  };
}

describe('computeScore', () => {
  it('returns 0/F for empty checks', () => {
    const result = computeScore([]);
    expect(result.total).toBe(0);
    expect(result.grade).toBe('F');
  });

  it('returns 100/A for all perfect scores', () => {
    const checks = [
      makeCheck('a', 1.0, 1),
      makeCheck('b', 1.0, 2),
      makeCheck('c', 1.0, 3),
    ];
    const result = computeScore(checks);
    expect(result.total).toBe(100);
    expect(result.grade).toBe('A');
  });

  it('returns 0/F for all zero scores', () => {
    const checks = [
      makeCheck('a', 0, 1),
      makeCheck('b', 0, 2),
    ];
    const result = computeScore(checks);
    expect(result.total).toBe(0);
    expect(result.grade).toBe('F');
  });

  it('applies weights correctly', () => {
    // Weighted avg: (1.0 * 1 + 0.0 * 3) / (1 + 3) = 0.25 → 25
    const checks = [
      makeCheck('pass', 1.0, 1),
      makeCheck('fail', 0.0, 3),
    ];
    const result = computeScore(checks);
    expect(result.total).toBe(25);
    expect(result.grade).toBe('F');
  });

  it('computes correct grade thresholds', () => {
    expect(computeScore([makeCheck('a', 0.9, 1)]).grade).toBe('A');
    expect(computeScore([makeCheck('a', 0.85, 1)]).grade).toBe('B');
    expect(computeScore([makeCheck('a', 0.75, 1)]).grade).toBe('C');
    expect(computeScore([makeCheck('a', 0.65, 1)]).grade).toBe('D');
    expect(computeScore([makeCheck('a', 0.5, 1)]).grade).toBe('F');
  });

  it('handles zero total weight', () => {
    const checks = [makeCheck('a', 1.0, 0)];
    const result = computeScore(checks);
    expect(result.total).toBe(0);
    expect(result.grade).toBe('F');
  });

  it('rounds to integer', () => {
    // (0.333 * 1) / 1 * 100 = 33.3 → 33
    const checks = [makeCheck('a', 0.333, 1)];
    const result = computeScore(checks);
    expect(result.total).toBe(33);
  });
});
