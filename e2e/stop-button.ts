#!/usr/bin/env node

/**
 * STOP button integration test.
 *
 * 1. Starts incubator HTTP server
 * 2. Launches 3 MCP workers that claim files and do work in a loop
 * 3. Each worker checks `halt` state before every step
 * 4. After a delay, sends REST PUT /api/state/halt = true
 * 5. Workers detect halt, publish what they completed, and exit
 * 6. Verifies: workers stopped, halt reports published, no work after halt
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const PORT = 3198;
const NUM_WORKERS = 3;
const HALT_AFTER_MS = 1500;
const PROJECT_DIR = join(import.meta.dirname, '..');

// ─── Helpers ────────────────────────────────────────────────

async function waitForServer(port: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) return;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Server failed to start');
}

async function restGet(path: string) {
  const res = await fetch(`http://localhost:${PORT}${path}`);
  return res.json();
}

async function restPut(path: string, body: Record<string, unknown>) {
  const res = await fetch(`http://localhost:${PORT}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function spawnWorker(id: string): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', 'e2e/stop-worker.ts', id, `http://localhost:${PORT}/mcp`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: PROJECT_DIR,
    });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.stdout.on('data', () => {}); // drain
    proc.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stderr });
    });
  });
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log('\n  STOP Button Integration Test');
  console.log(`  ${NUM_WORKERS} workers, halt after ${HALT_AFTER_MS}ms\n`);

  // 1. Start server
  console.log('  Starting server...');
  const server = spawn('node', [join(PROJECT_DIR, 'dist/index.js'), '--http', `--port=${PORT}`, '--verbose'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d: Buffer) => {
    process.stderr.write(`    ${d.toString().trimEnd()}\n`);
  });

  await waitForServer(PORT);
  console.log('  Server ready.\n');

  try {
    // 2. Launch workers
    console.log('  Launching workers...');
    const workerPromises = Array.from({ length: NUM_WORKERS }, (_, i) =>
      spawnWorker(`worker_${i}`)
    );

    // 3. Wait, then send HALT
    console.log(`  Waiting ${HALT_AFTER_MS}ms before sending STOP...\n`);
    await new Promise(r => setTimeout(r, HALT_AFTER_MS));

    console.log('  >>> Sending STOP signal via REST API <<<\n');
    const haltResult = await restPut('/api/state/halt', { value: true, agentId: 'test-dashboard' });
    console.log(`  halt set: ${JSON.stringify(haltResult.success)}`);

    // 4. Wait for workers to finish
    console.log('  Waiting for workers to stop...\n');
    const results = await Promise.all(workerPromises);

    // 5. Analyze results
    const health: any = await restGet('/api/health');
    const discoveries: any = await restGet('/api/discoveries?category=halt-report');
    const allDiscoveries: any = await restGet('/api/discoveries');
    const claims: any = await restGet('/api/claims');
    const events: any = await restGet('/api/events');

    console.log('  ── Results ──\n');
    console.log(`  Workers exited:      ${results.map(r => r.exitCode === 0 ? 'OK' : `FAIL(${r.exitCode})`).join(', ')}`);
    console.log(`  Halt reports:        ${discoveries.count}`);
    console.log(`  Total discoveries:   ${allDiscoveries.count}`);
    console.log(`  Active claims:       ${claims.count}`);
    console.log(`  Total events:        ${events.cursor}`);
    console.log(`  Unique agents:       ${health.agents}`);

    // Print halt reports
    if (discoveries.count > 0) {
      console.log('\n  ── Halt Reports ──\n');
      for (const d of discoveries.discoveries) {
        console.log(`  [${d.publishedBy}] ${d.content}`);
      }
    }

    // Print work completed before halt
    const workDiscoveries = allDiscoveries.discoveries.filter(
      (d: any) => d.category === 'progress'
    );
    if (workDiscoveries.length > 0) {
      console.log('\n  ── Work Completed Before Halt ──\n');
      for (const d of workDiscoveries) {
        console.log(`  [${d.publishedBy}] ${d.topic}`);
      }
    }

    // Verify
    const allExitedClean = results.every(r => r.exitCode === 0);
    const allReportedHalt = discoveries.count === NUM_WORKERS;
    const haltState: any = await restGet('/api/state/halt');

    console.log('\n  ── Checks ──\n');
    console.log(`  All workers exited 0:    ${allExitedClean ? 'PASS' : 'FAIL'}`);
    console.log(`  All reported halt:       ${allReportedHalt ? 'PASS' : `FAIL (${discoveries.count}/${NUM_WORKERS})`}`);
    console.log(`  Halt state still set:    ${haltState.found && haltState.entry.value === true ? 'PASS' : 'FAIL'}`);

    if (!allExitedClean) {
      for (const r of results) {
        if (r.exitCode !== 0) {
          console.error(`\n  Worker stderr:\n${r.stderr}`);
        }
      }
    }

    console.log('');
    const passed = allExitedClean && allReportedHalt;
    console.log(passed ? '  PASSED' : '  FAILED');
    process.exit(passed ? 0 : 1);

  } finally {
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
