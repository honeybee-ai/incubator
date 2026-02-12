/** Type-only declaration for optional @honeybee-ai/propolis dependency. */
declare module '@honeybee-ai/propolis' {
  import type { ToolEntry } from '@honeybee-ai/hivemind-sdk/integrations';
  export function TOOL_DEFS(workDir: string, guard: unknown, verbose: boolean): ToolEntry[];
  export function createPlugin(): import('@honeybee-ai/hivemind-sdk/integrations').IncubatorPlugin;
}
