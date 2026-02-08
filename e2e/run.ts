#!/usr/bin/env node

/**
 * E2E test runner: spawns N workers in both coordinated and uncoordinated modes,
 * then compares collision rates.
 *
 * Usage: npx tsx e2e/run.ts [--workers=4] [--rounds=10]
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const found = args.find(a => a.startsWith(`--${name}=`));
  return found ? found.split('=')[1] : def;
};

const NUM_WORKERS = parseInt(getArg('workers', '4'), 10);
const NUM_ROUNDS = parseInt(getArg('rounds', '10'), 10);
const VARIABLES = ['a', 'b', 'c', 'd', 'e'];
const BASE_DIR = '/tmp/incubator-e2e';
const SERVER_PORT = 3199;

// ─── Helpers ────────────────────────────────────────────────

function cleanDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function spawnWorker(script: string, id: string, workDir: string, extraArgs: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsx', script, id, workDir, ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: join(import.meta.dirname, '..'),
    });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`${id} exited ${code}: ${stderr}`));
      else resolve();
    });
  });
}

function analyzeRound(workDir: string, workerCount: number): RoundResult {
  const outputDir = join(workDir, 'output');
  const files = readdirSync(outputDir).filter(f => f.endsWith('.json'));

  // Read all output files to see final state
  const finalState: Record<string, { newName: string; renamedBy: string }> = {};
  for (const f of files) {
    const data = JSON.parse(readFileSync(join(outputDir, f), 'utf-8'));
    finalState[data.variable] = { newName: data.newName, renamedBy: data.renamedBy };
  }

  // Read all worker logs
  const logs: Array<{ workerId: string; assignments: Record<string, string> }> = [];
  for (let i = 0; i < workerCount; i++) {
    const logFile = join(workDir, `log-worker_${i}.json`);
    try {
      logs.push(JSON.parse(readFileSync(logFile, 'utf-8')));
    } catch { /* worker may have failed */ }
  }

  // Count collisions: multiple workers picked different names for same var
  let overwrites = 0;
  let nameConflicts = 0;
  let duplicateWork = 0;

  for (const varName of VARIABLES) {
    const workerChoices = logs
      .filter(l => l.assignments[varName])
      .map(l => ({ worker: l.workerId, name: l.assignments[varName] }));

    if (workerChoices.length > 1) {
      duplicateWork += workerChoices.length - 1;

      const uniqueNames = new Set(workerChoices.map(c => c.name));
      if (uniqueNames.size > 1) {
        nameConflicts++;
      }
      // The file only has one final value, so len-1 workers got overwritten
      overwrites += workerChoices.length - 1;
    }
  }

  return {
    variablesHandled: Object.keys(finalState).length,
    overwrites,
    nameConflicts,
    duplicateWork,
    workersReporting: logs.length,
  };
}

interface RoundResult {
  variablesHandled: number;
  overwrites: number;
  nameConflicts: number;
  duplicateWork: number;
  workersReporting: number;
}

interface ScenarioStats {
  rounds: number;
  totalOverwrites: number;
  totalNameConflicts: number;
  totalDuplicateWork: number;
  avgOverwrites: number;
  avgNameConflicts: number;
  avgDuplicateWork: number;
}

// ─── Scenarios ──────────────────────────────────────────────

async function runUncoordinated(round: number): Promise<RoundResult> {
  const workDir = join(BASE_DIR, 'uncoordinated', `round-${round}`);
  cleanDir(workDir);
  mkdirSync(join(workDir, 'output'), { recursive: true });

  // Spawn all workers concurrently
  const workers = Array.from({ length: NUM_WORKERS }, (_, i) =>
    spawnWorker('e2e/worker-uncoordinated.ts', `worker_${i}`, workDir)
  );
  await Promise.all(workers);

  return analyzeRound(workDir, NUM_WORKERS);
}

async function runCoordinated(round: number): Promise<RoundResult> {
  const workDir = join(BASE_DIR, 'coordinated', `round-${round}`);
  cleanDir(workDir);
  mkdirSync(join(workDir, 'output'), { recursive: true });

  // Start Incubator server
  const server = spawn('node', [
    join(import.meta.dirname, '..', 'dist', 'index.js'),
    '--http',
    `--port=${SERVER_PORT}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  // Wait for server to be ready
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timeout')), 5000);
    server.stderr.on('data', (data: Buffer) => {
      if (data.toString().includes('listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Server exited ${code}`));
    });
  });

  try {
    // Spawn all workers concurrently
    const workers = Array.from({ length: NUM_WORKERS }, (_, i) =>
      spawnWorker('e2e/worker-coordinated.ts', `worker_${i}`, workDir, [`http://localhost:${SERVER_PORT}/mcp`])
    );
    await Promise.all(workers);

    return analyzeRound(workDir, NUM_WORKERS);
  } finally {
    server.kill('SIGTERM');
    // Wait for clean exit
    await new Promise<void>(resolve => {
      server.on('close', () => resolve());
      setTimeout(resolve, 1000);
    });
  }
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log(`\n  Incubator E2E Test`);
  console.log(`  ${NUM_WORKERS} workers × ${NUM_ROUNDS} rounds × 5 variables\n`);

  // ── Run uncoordinated ──
  console.log('  ── Without Incubator (uncoordinated) ──\n');
  const uncoResults: RoundResult[] = [];
  for (let r = 0; r < NUM_ROUNDS; r++) {
    const result = await runUncoordinated(r);
    uncoResults.push(result);
    process.stdout.write(`    Round ${r + 1}: ${result.overwrites} overwrites, ${result.nameConflicts} name conflicts, ${result.duplicateWork} duplicate work\n`);
  }

  // ── Run coordinated ──
  console.log('\n  ── With Incubator (coordinated) ──\n');
  const coResults: RoundResult[] = [];
  for (let r = 0; r < NUM_ROUNDS; r++) {
    const result = await runCoordinated(r);
    coResults.push(result);
    process.stdout.write(`    Round ${r + 1}: ${result.overwrites} overwrites, ${result.nameConflicts} name conflicts, ${result.duplicateWork} duplicate work\n`);
  }

  // ── Summary ──
  function summarize(results: RoundResult[]): ScenarioStats {
    const n = results.length;
    return {
      rounds: n,
      totalOverwrites: results.reduce((s, r) => s + r.overwrites, 0),
      totalNameConflicts: results.reduce((s, r) => s + r.nameConflicts, 0),
      totalDuplicateWork: results.reduce((s, r) => s + r.duplicateWork, 0),
      avgOverwrites: results.reduce((s, r) => s + r.overwrites, 0) / n,
      avgNameConflicts: results.reduce((s, r) => s + r.nameConflicts, 0) / n,
      avgDuplicateWork: results.reduce((s, r) => s + r.duplicateWork, 0) / n,
    };
  }

  const unco = summarize(uncoResults);
  const co = summarize(coResults);

  console.log('\n  ════════════════════════════════════════');
  console.log('  RESULTS COMPARISON');
  console.log('  ════════════════════════════════════════\n');
  console.log(`  ${'Metric'.padEnd(25)} ${'Without'.padEnd(12)} ${'With'.padEnd(12)} ${'Improvement'.padEnd(12)}`);
  console.log(`  ${'─'.repeat(25)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(12)}`);

  const fmtRow = (label: string, without: number, withInc: number) => {
    const improvement = without === 0 ? 'N/A' : `${Math.round((1 - withInc / without) * 100)}%`;
    console.log(`  ${label.padEnd(25)} ${without.toFixed(1).padEnd(12)} ${withInc.toFixed(1).padEnd(12)} ${improvement.padEnd(12)}`);
  };

  fmtRow('Avg overwrites/round', unco.avgOverwrites, co.avgOverwrites);
  fmtRow('Avg name conflicts/round', unco.avgNameConflicts, co.avgNameConflicts);
  fmtRow('Avg duplicate work/round', unco.avgDuplicateWork, co.avgDuplicateWork);
  console.log(`  ${'─'.repeat(25)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(12)}`);
  fmtRow('Total overwrites', unco.totalOverwrites, co.totalOverwrites);
  fmtRow('Total name conflicts', unco.totalNameConflicts, co.totalNameConflicts);
  fmtRow('Total duplicate work', unco.totalDuplicateWork, co.totalDuplicateWork);

  console.log('');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
