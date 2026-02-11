import type { ToolClient } from '../agent/tool-client.js';
import type { ToolDef } from '../agent/types.js';
import type { CompoundContext } from './compound.js';
import type { WaggleInput } from './types.js';
import { compoundHandler } from './compound.js';
import { WAGGLE_TOOL_DEF, parseWaggleArgs } from './index.js';

/**
 * ToolClient that wraps the compound handler.
 * The runner sees exactly ONE tool (waggle). All operations
 * are batched and routed internally by the compound handler.
 */
export class WaggleToolClient implements ToolClient {
  constructor(private ctx: CompoundContext) {}

  getToolDefs(): ToolDef[] {
    return [WAGGLE_TOOL_DEF];
  }

  hasToolName(name: string): boolean {
    return name === 'waggle';
  }

  async callTool(_name: string, args: Record<string, unknown>): Promise<string> {
    const parsed = parseWaggleArgs(args);
    const result = await compoundHandler(parsed as WaggleInput, this.ctx);
    return JSON.stringify(result);
  }

  async close(): Promise<void> {
    // No-op — compound handler has no connections to close
  }
}
