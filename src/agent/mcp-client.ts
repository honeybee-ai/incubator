import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolClient } from './tool-client.js';
import type { ToolDef } from './types.js';

/**
 * MCP client that connects to a Propolis (or any MCP) server.
 * Discovers tools and forwards calls. Implements ToolClient interface.
 */
export class McpToolClient implements ToolClient {
  private client: Client;
  private tools: ToolDef[] = [];
  private toolNames = new Set<string>();

  constructor(name: string = 'hive') {
    this.client = new Client({ name, version: '0.1.0' });
  }

  /**
   * Connect via stdio (spawn Propolis as child process).
   * Target format: "stdio:--work-dir=/tmp --no-guard"
   */
  async connectStdio(command: string, args: string[]): Promise<void> {
    const transport = new StdioClientTransport({ command, args });
    await this.client.connect(transport);
    await this.discoverTools();
  }

  /**
   * Connect via HTTP to an existing MCP server.
   */
  async connectHttp(url: string): Promise<void> {
    const mcpUrl = url.endsWith('/mcp') ? url : `${url}/mcp`;
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    await this.client.connect(transport);
    await this.discoverTools();
  }

  private async discoverTools(): Promise<void> {
    const { tools } = await this.client.listTools();
    this.tools = tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: (t.inputSchema ?? { type: 'object', properties: {}, required: [] }) as ToolDef['function']['parameters'],
      },
    }));
    this.toolNames = new Set(this.tools.map(t => t.function.name));
  }

  getToolDefs(): ToolDef[] {
    return this.tools;
  }

  hasToolName(name: string): boolean {
    return this.toolNames.has(name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    if (content && content.length > 0) {
      return content.map(c => c.text ?? '').join('\n');
    }
    return JSON.stringify(result);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/**
 * Parse propolis target string and return connected client.
 * Formats:
 * - "stdio:--work-dir=/tmp --no-guard" → spawn propolis subprocess
 * - "http://localhost:3200" → connect to existing server
 */
export async function connectPropolis(target: string): Promise<McpToolClient> {
  const client = new McpToolClient('hive-propolis');

  if (target.startsWith('stdio:')) {
    const argsStr = target.slice('stdio:'.length);
    const args = argsStr.split(/\s+/).filter(Boolean);
    await client.connectStdio('propolis', args);
  } else if (target.startsWith('http://') || target.startsWith('https://')) {
    await client.connectHttp(target);
  } else {
    throw new Error(`Invalid propolis target: "${target}". Use "stdio:..." or "http://..."`);
  }

  return client;
}

/**
 * Connect to incubator via MCP (for --no-acp benchmarking mode).
 */
export async function connectIncubatorMcp(serverUrl: string, _namespace: string): Promise<McpToolClient> {
  const client = new McpToolClient('hive-incubator');
  await client.connectHttp(serverUrl);
  return client;
}
