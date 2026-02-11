import type { ToolDef } from './types.js';

/**
 * Abstract interface for tool access.
 * Both NativeToolClient (in-process) and McpToolClient (MCP) implement this.
 * The runner takes ToolClient — doesn't care which mode.
 */
export interface ToolClient {
  getToolDefs(): ToolDef[];
  hasToolName(name: string): boolean;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}
