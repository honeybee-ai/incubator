/**
 * Uncoordinated worker - simulates an agent with no shared state.
 * Reads a shared workspace, picks names for variables, writes results.
 * No awareness of other workers.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const workerId = process.argv[2] ?? 'worker_0';
const workDir = process.argv[3] ?? '/tmp/incubator-e2e';
const outputDir = join(workDir, 'output');
const logFile = join(workDir, `log-${workerId}.json`);

mkdirSync(outputDir, { recursive: true });

// The "task": rename 5 variables to descriptive names
// Each worker independently picks names from a pool
const variables = ['a', 'b', 'c', 'd', 'e'];
const namePool: Record<string, string[]> = {
  a: ['count', 'total', 'counter', 'numItems'],
  b: ['name', 'label', 'title', 'displayName'],
  c: ['isActive', 'enabled', 'isOn', 'active'],
  d: ['items', 'list', 'entries', 'collection'],
  e: ['callback', 'handler', 'onComplete', 'fn'],
};

interface WorkerLog {
  workerId: string;
  assignments: Record<string, string>;
  filesWritten: string[];
  timing: { start: number; end: number; durationMs: number };
}

async function work() {
  const start = Date.now();
  const assignments: Record<string, string> = {};
  const filesWritten: string[] = [];

  for (const varName of variables) {
    // Simulate "thinking" - random delay 10-50ms
    await new Promise(r => setTimeout(r, 10 + Math.random() * 40));

    // Pick a name (deterministic-ish: first choice biased, simulating how
    // agents tend to pick the "obvious" first choice)
    const pool = namePool[varName];
    // 60% chance of picking first (most obvious) name, 40% random
    const pick = Math.random() < 0.6 ? pool[0] : pool[Math.floor(Math.random() * pool.length)];
    assignments[varName] = pick;

    // Write to shared output file (the collision point)
    const outFile = join(outputDir, `rename-${varName}.json`);
    writeFileSync(outFile, JSON.stringify({
      variable: varName,
      newName: pick,
      renamedBy: workerId,
      at: new Date().toISOString(),
    }, null, 2));
    filesWritten.push(outFile);
  }

  const end = Date.now();
  const log: WorkerLog = {
    workerId,
    assignments,
    filesWritten,
    timing: { start, end, durationMs: end - start },
  };
  writeFileSync(logFile, JSON.stringify(log, null, 2));
}

work().catch(err => {
  console.error(`[${workerId}] Fatal:`, err);
  process.exit(1);
});
