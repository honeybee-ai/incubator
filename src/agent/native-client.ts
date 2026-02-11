import type { ToolClient } from './tool-client.js';
import type { ToolDef } from './types.js';
import type { Guard } from '../propolis/guard.js';
import { TOOL_DEFS, type ToolEntry } from '../propolis/tools/defs.js';

/**
 * In-process tool client — runs Propolis tool handlers directly.
 * No MCP overhead, no child process. Used in Worker mode.
 */
export class NativeToolClient implements ToolClient {
  private entries: ToolEntry[];
  private entryMap: Map<string, ToolEntry>;
  private defs: ToolDef[];

  constructor(workDir: string, guard: Guard | null, verbose?: boolean, toolFilter?: string[] | null) {
    let entries = TOOL_DEFS(workDir, guard, verbose);

    // Filter tools if whitelist provided
    if (toolFilter) {
      const filterSet = new Set(toolFilter);
      entries = entries.filter(e => filterSet.has(e.def.function.name));
    }

    this.entries = entries;
    this.entryMap = new Map(entries.map(e => [e.def.function.name, e]));
    this.defs = entries.map(e => e.def);
  }

  getToolDefs(): ToolDef[] {
    return this.defs;
  }

  hasToolName(name: string): boolean {
    return this.entryMap.has(name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const entry = this.entryMap.get(name);
    if (!entry) {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }

    const result = await entry.handler(args);

    // Unwrap ToolResult { content: [{ text }] } → string
    // Same transform McpToolClient does over the wire
    if (result.content && result.content.length > 0) {
      return result.content.map(c => c.text ?? '').join('\n');
    }
    return JSON.stringify(result);
  }

  async close(): Promise<void> {
    // No-op — no connections to close
  }
}
