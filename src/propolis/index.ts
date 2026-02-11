#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createServer } from './server.js';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      args[key] = rest.length > 0 ? rest.join('=') : true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const isHttp = args['http'] === true;
  const port = typeof args['port'] === 'string' ? parseInt(args['port'], 10) : 3200;
  const workDir = resolve(typeof args['work-dir'] === 'string' ? args['work-dir'] : process.cwd());
  const noGuard = args['no-guard'] === true;
  const verbose = args['verbose'] === true;

  if (isHttp) {
    // HTTP mode: multiple agents can connect
    const sessions = new Map<string, { server: ReturnType<typeof createServer>; transport: StreamableHTTPServerTransport }>();

    const httpServer = createHttpServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);

      if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found. Use /mcp endpoint.' }));
        return;
      }

      // Check for existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      // New session
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          console.error(`[propolis] Session ${sid} started`);
          sessions.set(sid, { server: mcpServer, transport });
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          sessions.delete(sid);
          console.error(`[propolis] Session ${sid} closed`);
        }
      };

      const mcpServer = createServer({ workDir, noGuard, verbose });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    });

    httpServer.listen(port, () => {
      console.error(`[propolis] HTTP server listening on port ${port}`);
      console.error(`[propolis] MCP endpoint: http://localhost:${port}/mcp`);
      console.error(`[propolis] Work dir:     ${workDir}`);
      console.error(`[propolis] Guard:        ${noGuard ? 'disabled' : 'enabled'}`);
    });

    process.on('SIGINT', () => {
      console.error('\n[propolis] Shutting down...');
      for (const [, session] of sessions) {
        session.server.close();
      }
      httpServer.close();
      process.exit(0);
    });
  } else {
    // Stdio mode: single agent
    const server = createServer({ workDir, noGuard, verbose });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[propolis] Running on stdio`);
    console.error(`[propolis] Work dir: ${workDir}`);
    console.error(`[propolis] Guard:    ${noGuard ? 'disabled' : 'enabled'}`);
  }
}

main().catch((err) => {
  console.error('[propolis] Fatal error:', err);
  process.exit(1);
});
