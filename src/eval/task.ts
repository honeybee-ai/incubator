/**
 * Task parser — reads eval task YAML definitions.
 */
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import type { EvalTask } from './types.js';

/**
 * Parse an eval task YAML file into a typed EvalTask.
 * Validates required fields: name, task.
 */
export function parseEvalTask(filePath: string): EvalTask {
  const content = readFileSync(filePath, 'utf-8');
  const raw = yaml.load(content) as Record<string, unknown>;

  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid eval task file: expected YAML object');
  }

  if (typeof raw.name !== 'string' || !raw.name) {
    throw new Error('Eval task requires a "name" field');
  }

  if (typeof raw.task !== 'string' || !raw.task) {
    throw new Error('Eval task requires a "task" field');
  }

  // Validate check weights if present
  const checks = raw.checks as Record<string, Record<string, unknown>> | undefined;
  if (checks && typeof checks === 'object') {
    for (const [name, cfg] of Object.entries(checks)) {
      if (typeof cfg?.weight !== 'number' || cfg.weight <= 0) {
        throw new Error(`Eval task check "${name}" requires a positive "weight" number`);
      }
    }
  }

  return {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    task: raw.task,
    seed: raw.seed as Record<string, string> | undefined,
    expected_files: Array.isArray(raw.expected_files) ? raw.expected_files.map(String) : undefined,
    checks: checks as EvalTask['checks'],
    metrics: raw.metrics as EvalTask['metrics'],
    brood: typeof raw.brood === 'string' ? raw.brood : undefined,
    provider: typeof raw.provider === 'string' ? raw.provider : undefined,
  };
}
