import type { ToolClient } from './tool-client.js';
import type { ToolDef } from './types.js';
import type { ToolEntry } from '@honeybee-ai/hivemind-sdk/integrations';

/**
 * In-process tool client — runs tool handlers directly.
 * No MCP overhead, no child process. Used in Worker mode.
 *
 * Accepts ToolEntry[] from PluginManager.
 */
export class NativeToolClient implements ToolClient {
  private entryMap: Map<string, { handler: (args: Record<string, unknown>) => Promise<any> }>;
  private _defs: ToolDef[];

  constructor(entries: ToolEntry[], toolFilter?: string[] | null) {
    let filtered = entries;

    // Filter tools if whitelist provided
    if (toolFilter) {
      const filterSet = new Set(toolFilter);
      filtered = entries.filter(e => filterSet.has(e.def.function.name));
    }

    this.entryMap = new Map(filtered.map(e => [e.def.function.name, e]));
    this._defs = filtered.map(e => e.def as unknown as ToolDef);
  }

  getToolDefs(): ToolDef[] {
    return this._defs;
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
    if (result.content && result.content.length > 0) {
      return result.content.map((c: { text?: string }) => c.text ?? '').join('\n');
    }
    return JSON.stringify(result);
  }

  async close(): Promise<void> {
    // No-op — no connections to close
  }
}
