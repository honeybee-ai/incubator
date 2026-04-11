/**
 * Duck-typed wait parameter.
 * true = wait for any event, "type" = specific event, ["a","b"] = any of these,
 * number = pure sleep (ms), { types, timeout } = explicit form.
 */
export type WaitSpec =
  | boolean
  | string
  | string[]
  | number
  | { types?: string[]; timeout?: number };

/** Normalized wait condition after duck-type resolution. */
export interface NormalizedWait {
  types: string[] | null;  // null = any event
  timeout: number;         // 0 = forever, >0 = ms
  pureDelay: boolean;      // true = number input (just sleep, no events)
}

/** A single operation in the waggle batch. */
export interface Operation {
  do: string;
  [key: string]: unknown;
}

/** Result of a single operation. */
export interface OpResult {
  op: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** Full waggle tool input. */
export interface WaggleInput {
  dance: Operation[];
  wait?: WaitSpec;
}

/** Full waggle tool result. */
export interface WaggleResult {
  results: OpResult[];
  wakeEvents?: string[];
}

/** Allowed primitives per role (from protocol spec). */
export interface Primitives {
  env?: string[];
  acp?: string[];
}

/** ACP backend interface — anything that provides coordination ops. */
export interface AcpBackend {
  publishEvent(type: string, data?: Record<string, unknown>): Promise<string>;
  claimResource(resource: string, reason?: string): Promise<string>;
  releaseResource(resource: string): Promise<string>;
  getState(key?: string): Promise<string>;
  setState(key: string, value: unknown): Promise<string>;
  waitForWake(condition: { types?: string[] | null; timeout?: number }): Promise<string[]>;
  /** Load an ACP protocol spec at runtime. spec is YAML or JSON string. */
  loadProtocol?(spec: string): Promise<string>;

  // Queen tools — optional, only implemented when queen context is available
  spawnAgent?(role: string, config?: Record<string, unknown>): Promise<string>;
  killAgent?(agentId: string): Promise<string>;
  getStatus?(): Promise<string>;
  getBudget?(): Promise<string>;
  approveRequest?(requestId: string, decision: string): Promise<string>;
  escalate?(message: string, severity?: string): Promise<string>;
}
