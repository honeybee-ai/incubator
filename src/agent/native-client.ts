import type { ToolClient } from './tool-client.js';
import type { ToolDef } from './types.js';
import type { Guard } from '../propolis/guard.js';
import { getPropolis } from '../tool-loader.js';

/**
 * In-process tool client — runs Propolis tool handlers directly.
 * No MCP overhead, no child process. Used in Worker mode.
 *
 * Requires @honeybee-ai/propolis to be loaded via loadPropolis() first.
 * If propolis is not available, constructor throws.
 */
export class NativeToolClient implements ToolClient {
  private entryMap: Map<string, { handler: (args: Record<string, unknown>) => Promise<any> }>;
  private _defs: ToolDef[];

  constructor(workDir: string, guard: Guard | null, verbose?: boolean, toolFilter?: string[] | null) {
    const propolis = getPropolis();
    if (!propolis) {
      throw new Error(
        'NativeToolClient requires @honeybee-ai/propolis. ' +
        'Install it with: pnpm add @honeybee-ai/propolis'
      );
    }

    let entries = propolis.TOOL_DEFS(workDir, guard, verbose);

    // Filter tools if whitelist provided
    if (toolFilter) {
      const filterSet = new Set(toolFilter);
      entries = entries.filter(e => filterSet.has(e.def.function.name));
    }

    this.entryMap = new Map(entries.map(e => [e.def.function.name, e]));
    this._defs = entries.map(e => e.def as unknown as ToolDef);
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
