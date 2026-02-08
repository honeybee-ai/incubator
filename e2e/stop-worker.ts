/**
 * Worker for the STOP button test.
 * Connects via MCP, does work in a loop, checks halt state before each step.
 * When halt=true, publishes a report and exits cleanly.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const workerId = process.argv[2] ?? 'worker_0';
const serverUrl = process.argv[3] ?? 'http://localhost:3198/mcp';

// Files this worker will "extract" from a monolith
const files = [
  'utils.js', 'api.js', 'db.js', 'auth.js', 'logger.js',
  'config.js', 'router.js', 'middleware.js', 'cache.js', 'queue.js',
];

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
  return JSON.parse(text);
}

async function checkHalt(client: Client): Promise<boolean> {
  const state = await callTool(client, 'incubator_getState', { key: 'halt' });
  return state.found && state.entry.value === true;
}

async function work() {
  const client = new Client({ name: workerId, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  await client.connect(transport);

  const completed: string[] = [];

  for (const file of files) {
    // Check halt BEFORE each step
    if (await checkHalt(client)) {
      await callTool(client, 'incubator_publishDiscovery', {
        topic: `halted:${workerId}`,
        content: `${workerId} halted. Completed ${completed.length} files: ${completed.join(', ') || 'none'}`,
        category: 'halt-report',
      });
      await client.close();
      return;
    }

    // Try to claim the file
    const claim = await callTool(client, 'incubator_claim', {
      resource: `file:${file}`,
      value: `${workerId} extracting ${file}`,
      ttlMs: 30000,
    });

    if (claim.status === 'rejected') {
      continue; // someone else has it
    }

    // Simulate work (200-500ms)
    await new Promise(r => setTimeout(r, 200 + Math.random() * 300));

    // Check halt AGAIN after work (might have been sent during our "extraction")
    if (await checkHalt(client)) {
      await callTool(client, 'incubator_releaseClaim', { resource: `file:${file}` });
      await callTool(client, 'incubator_publishDiscovery', {
        topic: `halted:${workerId}`,
        content: `${workerId} halted. Completed ${completed.length} files: ${completed.join(', ') || 'none'}. Was working on ${file}.`,
        category: 'halt-report',
      });
      await client.close();
      return;
    }

    // "Write" the extracted file (just publish a discovery)
    completed.push(file);
    await callTool(client, 'incubator_publishDiscovery', {
      topic: `extracted:${file}`,
      content: `${workerId} extracted ${file} from monolith`,
      category: 'progress',
    });

    // Release claim
    await callTool(client, 'incubator_releaseClaim', { resource: `file:${file}` });
  }

  // Finished all work without being halted (shouldn't happen in the test, but handle it)
  await callTool(client, 'incubator_publishDiscovery', {
    topic: `halted:${workerId}`,
    content: `${workerId} finished all work before halt. Completed: ${completed.join(', ')}`,
    category: 'halt-report',
  });

  await client.close();
}

work().catch(err => {
  console.error(`[${workerId}] Fatal:`, err);
  process.exit(1);
});
