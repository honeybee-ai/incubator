/**
 * Types for the ACP MCP server.
 * Mirrors the waggle types from incubator but only includes ACP operations.
 */

export type WaitSpec = boolean | string | string[] | number | { types?: string[]; timeout?: number };

export interface NormalizedWait {
  types: string[] | null;
  timeout: number;
  pureDelay: boolean;
}

export interface Operation {
  do: string;
  [key: string]: unknown;
}

export interface OpResult {
  op: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface AcpBackend {
  publishEvent(type: string, data?: Record<string, unknown>): Promise<string>;
  claimResource(resource: string, value?: string): Promise<string>;
  releaseResource(resource: string): Promise<string>;
  getState(key?: string): Promise<string>;
  setState(key: string, value: unknown): Promise<string>;
  waitForWake(condition: { types?: string[] | null; timeout?: number }): Promise<string[]>;
}
