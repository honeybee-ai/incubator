import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadGuard } from './guard.js';
import { TOOL_DEFS } from './tools/defs.js';

export interface PropolisOptions {
  workDir: string;
  noGuard?: boolean;
  verbose?: boolean;
}

export function createServer(options: PropolisOptions) {
  const { workDir, noGuard, verbose } = options;
  const guard = noGuard ? null : loadGuard(verbose);

  const server = new McpServer({
    name: 'propolis',
    version: '0.1.0',
  });

  const entries = TOOL_DEFS(workDir, guard, verbose);
  for (const entry of entries) {
    server.registerTool(
      entry.def.function.name,
      {
        description: entry.def.function.description,
        inputSchema: entry.schema,
      },
      async (args: Record<string, unknown>) => entry.handler(args),
    );
  }

  return server;
}
