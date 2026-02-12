/** MCP tool result format. Kept in incubator for backward compatibility. */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

export function textResult(data: unknown): ToolResult {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data) }] };
}

export function errorResult(msg: string): ToolResult {
  return textResult({ error: msg });
}
