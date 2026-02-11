import { createRequire } from 'node:module';

interface ScanResult {
  pass: boolean;
  score: number;
  action: 'PASS' | 'LOG' | 'WARN' | 'BLOCK';
  findings: Array<{ category: string; severity: string; description: string }>;
  summary: string;
}

export interface Guard {
  scan(message: string): ScanResult;
}

let cachedGuard: Guard | null | undefined;

/**
 * Load Carapace scanner. Returns null if not installed.
 */
export function loadGuard(verbose?: boolean): Guard | null {
  if (cachedGuard !== undefined) return cachedGuard;

  try {
    const require = createRequire(import.meta.url);
    const mod = require('@honeybee-ai/carapace');
    cachedGuard = mod as Guard;
    if (verbose) {
      console.error('[propolis] Carapace loaded');
    }
    return cachedGuard;
  } catch {
    cachedGuard = null;
    if (verbose) {
      console.error('[propolis] Carapace not installed — guard disabled');
    }
    return null;
  }
}

/**
 * Scan input fields with Carapace. Returns an error message if blocked, null if clean.
 */
export function scanInput(guard: Guard | null, fields: (string | undefined)[], verbose?: boolean): string | null {
  if (!guard) return null;

  const text = fields.filter(Boolean).join('\n');
  if (!text) return null;

  const result = guard.scan(text);

  if (verbose && result.findings.length > 0) {
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`  ${ts} [carapace] score=${result.score} action=${result.action} findings=${result.findings.length}`);
  }

  if (result.action === 'BLOCK') {
    return `Blocked by security policy: ${result.summary}`;
  }

  if (result.action === 'WARN' && verbose) {
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`  ${ts} [carapace] WARN: ${result.summary}`);
  }

  return null;
}
