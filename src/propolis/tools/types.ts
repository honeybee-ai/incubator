/**
 * Re-export canonical tool types from SDK.
 * Kept for backward compatibility — internal code imports from here.
 */
export type { ToolResult } from '@honeybee-ai/hivemind-sdk/integrations';

/** Helper: wrap data as a ToolResult. */
export function textResult(data: unknown): import('@honeybee-ai/hivemind-sdk/integrations').ToolResult {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data) }] };
}

/** Helper: wrap error message as a ToolResult. */
export function errorResult(msg: string): import('@honeybee-ai/hivemind-sdk/integrations').ToolResult {
  return textResult({ error: msg });
}
