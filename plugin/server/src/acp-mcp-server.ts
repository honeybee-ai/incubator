#!/usr/bin/env node
/**
 * ACP MCP Server for Claude Code.
 *
 * Exposes a single "acp" tool that handles all coordination operations:
 * publish, claim, release, get_state, set_state, wait.
 *
 * Claude Code's native tools handle the env side (Read, Write, Bash, etc.).
 * This server only exposes the ACP coordination layer.
 *
 * Config via env vars:
 *   INCUBATOR_URL  - incubator server URL
 *   ACP_NAMESPACE  - coordination namespace
 *   ACP_AGENT_ID   - this agent's ID
 *   ACP_ROLE       - agent's role
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { AcpHttpBackend } from './http-backend.js';
import { normalizeWait } from './wait.js';
import type { AcpBackend, WaitSpec, Operation, OpResult } from './types.js';

const ACP_ACTIONS = new Set(['publish', 'claim', 'release', 'get_state', 'set_state']);

/**
 * Execute a single ACP operation against the backend.
 */
async function executeOp(op: Operation, backend: AcpBackend): Promise<OpResult> {
  const action = op.do;

  if (!ACP_ACTIONS.has(action)) {
    return { op: action, ok: false, error: `Unknown ACP action "${action}". Available: publish, claim, release, get_state, set_state` };
  }

  try {
    switch (action) {
      case 'publish': {
        const result = await backend.publishEvent(
          op.type as string,
          (op.data as Record<string, unknown>) ?? {},
        );
        return { op: action, ok: true, data: result };
      }
      case 'claim': {
        const result = await backend.claimResource(
          op.resource as string,
          op.value as string | undefined,
        );
        return { op: action, ok: true, data: result };
      }
      case 'release': {
        const result = await backend.releaseResource(op.resource as string);
        return { op: action, ok: true, data: result };
      }
      case 'get_state': {
        const result = await backend.getState(op.key as string | undefined);
        return { op: action, ok: true, data: result };
      }
      case 'set_state': {
        const result = await backend.setState(
          op.key as string,
          op.value,
        );
        return { op: action, ok: true, data: result };
      }
      default:
        return { op: action, ok: false, error: `Unhandled action "${action}"` };
    }
  } catch (err) {
    return { op: action, ok: false, error: (err as Error).message };
  }
}

/**
 * Handle the compound ACP tool call.
 */
export async function handleAcpTool(
  args: Record<string, unknown>,
  backend: AcpBackend,
): Promise<{ results: OpResult[]; wakeEvents?: string[] }> {
  // Parse dance
  let dance: Operation[];
  const rawDance = args.dance;
  if (typeof rawDance === 'string') {
    dance = JSON.parse(rawDance);
  } else if (Array.isArray(rawDance)) {
    dance = rawDance as Operation[];
  } else {
    dance = [];
  }

  // Execute operations sequentially
  const results: OpResult[] = [];
  for (const op of dance) {
    results.push(await executeOp(op, backend));
  }

  // Handle wait
  let wakeEvents: string[] | undefined;
  if (args.wait !== undefined && args.wait !== false) {
    let waitSpec: WaitSpec;
    if (typeof args.wait === 'string') {
      try {
        waitSpec = JSON.parse(args.wait);
      } catch {
        waitSpec = args.wait; // plain string event type
      }
    } else {
      waitSpec = args.wait as WaitSpec;
    }

    const normalized = normalizeWait(waitSpec);

    if (normalized.pureDelay) {
      // Just sleep
      await new Promise(r => setTimeout(r, normalized.timeout));
      wakeEvents = [];
    } else {
      // Wait for events via backend
      wakeEvents = await backend.waitForWake({
        types: normalized.types,
        timeout: normalized.timeout,
      });
    }
  }

  return { results, ...(wakeEvents !== undefined ? { wakeEvents } : {}) };
}

/**
 * Create and start the MCP server.
 */
export function createServer(backend: AcpBackend): Server {
  const server = new Server(
    { name: 'acp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // List tools — one tool: "acp"
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'acp',
        description: [
          'Execute ACP coordination operations. Operations run sequentially.',
          'Actions: publish, claim, release, get_state, set_state.',
          'Wait: true (any event), "type" (specific), ["a","b"] (any of), number (sleep ms), {types,timeout}.',
        ].join(' '),
        inputSchema: {
          type: 'object' as const,
          properties: {
            dance: {
              type: 'string',
              description: 'JSON array of operations. Each op: { "do": "action", ...params }. Example: [{"do":"publish","type":"task.done","data":{"result":"ok"}}]',
            },
            wait: {
              type: 'string',
              description: 'Optional wait spec after ops. true, "event_type", ["a","b"], 30000, or {"types":["a"],"timeout":5000}. Omit for no wait.',
            },
          },
          required: ['dance'],
        },
      },
    ],
  }));

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'acp') {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }

    try {
      const result = await handleAcpTool(
        request.params.arguments ?? {},
        backend,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `ACP error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ─── Main (only when run directly, not imported) ─────────────────

const isMainModule = process.argv[1] &&
  (process.argv[1].endsWith('acp-mcp-server.js') || process.argv[1].endsWith('acp-mcp-server.ts'));

if (isMainModule) {
  (async () => {
    const serverUrl = process.env.INCUBATOR_URL;
    const namespace = process.env.ACP_NAMESPACE ?? 'default';
    const agentId = process.env.ACP_AGENT_ID;

    if (!serverUrl || !agentId) {
      console.error('Missing required env vars: INCUBATOR_URL, ACP_AGENT_ID');
      process.exit(1);
    }

    const backend = new AcpHttpBackend(serverUrl, namespace, agentId);
    const server = createServer(backend);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  })().catch((err) => {
    console.error('ACP MCP server error:', err);
    process.exit(1);
  });
}
