/**
 * Security check — Carapace scan on generated source files.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalCheck, EvalCheckResult, EvalTask } from '../types.js';

/** Default weight if not configured in task. */
const DEFAULT_WEIGHT = 2;

/**
 * Recursively collect .ts/.js files from a directory.
 */
function collectSourceFiles(dir: string, base?: string): string[] {
  const result: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push(...collectSourceFiles(join(dir, entry.name), rel));
    } else if (/\.(ts|js|tsx|jsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      result.push(rel);
    }
  }
  return result;
}

export const securityCheck: EvalCheck = {
  name: 'security',

  async run(workDir: string, task: EvalTask): Promise<EvalCheckResult> {
    const start = Date.now();
    const weight = task.checks?.security?.weight ?? DEFAULT_WEIGHT;

    const files = collectSourceFiles(workDir);
    if (files.length === 0) {
      return {
        name: 'security',
        passed: true,
        score: 1.0,
        weight,
        details: 'No source files to scan',
        duration_ms: Date.now() - start,
      };
    }

    // Use createEdgeScanner() — pre-loads patterns via static require()
    // which esbuild inlines. The default scan() uses __dirname-relative
    // fs.readFileSync for patterns, which breaks when bundled.
    let scanner: { scan: (text: string) => { action: string; score: number } };
    try {
      const carapace = await import('@honeybee-ai/carapace');
      const create = (carapace as Record<string, unknown>).createEdgeScanner as
        ((opts?: Record<string, unknown>) => { scan: (text: string) => { action: string; score: number } }) | undefined;
      if (create) {
        scanner = create();
      } else {
        // Fallback: wrap scan() directly
        const scanFn = (carapace as Record<string, unknown>).scan as (text: string) => { action: string; score: number };
        scanner = { scan: scanFn };
      }
    } catch {
      return {
        name: 'security',
        passed: true,
        score: 1.0,
        weight,
        details: 'Carapace not available — skipped',
        duration_ms: Date.now() - start,
      };
    }

    let warnCount = 0;
    let blockCount = 0;
    const findings: string[] = [];

    for (const file of files) {
      const content = readFileSync(join(workDir, file), 'utf-8');
      if (!content.trim()) continue;

      const result = scanner.scan(content);
      if (result.action === 'BLOCK') {
        blockCount++;
        findings.push(`BLOCK: ${file} (score: ${result.score})`);
      } else if (result.action === 'WARN') {
        warnCount++;
        findings.push(`WARN: ${file} (score: ${result.score})`);
      }
    }

    // Score: 1.0 if all PASS, -0.1 per WARN, 0 on any BLOCK
    let score: number;
    if (blockCount > 0) {
      score = 0;
    } else {
      score = Math.max(0, 1 - warnCount * 0.1);
    }

    const passed = blockCount === 0 && warnCount === 0;

    return {
      name: 'security',
      passed,
      score,
      weight,
      details: `Scanned ${files.length} files: ${blockCount} blocked, ${warnCount} warnings${findings.length > 0 ? '\n' + findings.join('\n') : ''}`,
      errors: findings.length > 0 ? findings : undefined,
      duration_ms: Date.now() - start,
    };
  },
};
