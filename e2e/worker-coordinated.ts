/**
 * Coordinated worker - uses Incubator MCP server for shared state.
 * Claims variables before renaming, checks discoveries for existing decisions,
 * publishes its choices for others to see.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const workerId = process.argv[2] ?? 'worker_0';
const workDir = process.argv[3] ?? '/tmp/incubator-e2e';
const serverUrl = process.argv[4] ?? 'http://localhost:3100/mcp';
const outputDir = join(workDir, 'output');
const logFile = join(workDir, `log-${workerId}.json`);

mkdirSync(outputDir, { recursive: true });

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
  skipped: string[];
  filesWritten: string[];
  claimsWon: number;
  claimsLost: number;
  timing: { start: number; end: number; durationMs: number };
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
  return JSON.parse(text);
}

async function work() {
  const start = Date.now();

  // Connect to Incubator
  const client = new Client({ name: workerId, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  await client.connect(transport);

  const assignments: Record<string, string> = {};
  const skipped: string[] = [];
  const filesWritten: string[] = [];
  let claimsWon = 0;
  let claimsLost = 0;

  for (const varName of variables) {
    // Simulate "thinking" - random delay 10-50ms
    await new Promise(r => setTimeout(r, 10 + Math.random() * 40));

    // Check if someone already renamed this variable
    const existing = await callTool(client, 'incubator_searchDiscoveries', {
      query: `rename:${varName}`,
      category: 'rename',
    });

    if (existing.count > 0) {
      // Someone already handled it - skip
      skipped.push(varName);
      continue;
    }

    // Try to claim the variable
    const claim = await callTool(client, 'incubator_claim', {
      resource: `var:${varName}`,
      value: `${workerId} renaming`,
      ttlMs: 30000,
    });

    if (claim.status === 'rejected') {
      // Someone else got it first
      claimsLost++;
      skipped.push(varName);
      continue;
    }

    claimsWon++;

    // Check discoveries again (another worker might have published between our check and claim)
    const recheck = await callTool(client, 'incubator_searchDiscoveries', {
      query: `rename:${varName}`,
      category: 'rename',
    });

    if (recheck.count > 0) {
      await callTool(client, 'incubator_releaseClaim', { resource: `var:${varName}` });
      skipped.push(varName);
      continue;
    }

    // We own it — pick a name
    const pool = namePool[varName];
    const pick = Math.random() < 0.6 ? pool[0] : pool[Math.floor(Math.random() * pool.length)];
    assignments[varName] = pick;

    // Publish our decision so others see it
    await callTool(client, 'incubator_publishDiscovery', {
      topic: `rename:${varName}`,
      content: `Variable '${varName}' renamed to '${pick}' by ${workerId}`,
      category: 'rename',
    });

    // Write to shared output file
    const outFile = join(outputDir, `rename-${varName}.json`);
    writeFileSync(outFile, JSON.stringify({
      variable: varName,
      newName: pick,
      renamedBy: workerId,
      at: new Date().toISOString(),
    }, null, 2));
    filesWritten.push(outFile);

    // Release claim
    await callTool(client, 'incubator_releaseClaim', { resource: `var:${varName}` });
  }

  const end = Date.now();
  const log: WorkerLog = {
    workerId,
    assignments,
    skipped,
    filesWritten,
    claimsWon,
    claimsLost,
    timing: { start, end, durationMs: end - start },
  };
  writeFileSync(logFile, JSON.stringify(log, null, 2));

  await client.close();
}

work().catch(err => {
  console.error(`[${workerId}] Fatal:`, err);
  process.exit(1);
});
