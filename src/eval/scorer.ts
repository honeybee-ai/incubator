/**
 * Scorer — weighted aggregation of check results into grade.
 */
import type { EvalCheckResult } from './types.js';

/**
 * Grade thresholds:
 *   A: 90+
 *   B: 80+
 *   C: 70+
 *   D: 60+
 *   F: <60
 */
function toGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/**
 * Compute weighted score from check results.
 * Each check contributes: score * weight.
 * Total = sum(score * weight) / sum(weight) * 100.
 *
 * Returns 0 if no checks ran.
 */
export function computeScore(checks: EvalCheckResult[]): { total: number; grade: string } {
  if (checks.length === 0) {
    return { total: 0, grade: 'F' };
  }

  let weightedSum = 0;
  let totalWeight = 0;

  for (const check of checks) {
    weightedSum += check.score * check.weight;
    totalWeight += check.weight;
  }

  if (totalWeight === 0) {
    return { total: 0, grade: 'F' };
  }

  const total = Math.round((weightedSum / totalWeight) * 100);
  return { total, grade: toGrade(total) };
}
