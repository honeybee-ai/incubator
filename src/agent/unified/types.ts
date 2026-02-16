/**
 * Unified Agent Interface — shared types for all agent execution paths.
 *
 * All agent types (worker, drone, claude, mock) implement UnifiedAgent.
 * Adapters wrap existing classes — no modifications to internals.
 */
import type { TokenUsage } from '../types.js';

// ─── Agent Status ────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'running' | 'sleeping' | 'stopped' | 'error';

// ─── Agent Result ────────────────────────────────────────────────

export interface AgentResult {
  agentId: string;
  role: string;
  status: 'completed' | 'error' | 'stopped';
  iterations: number;
  error?: string;
  usage: TokenUsage;
  iterationUsage?: TokenUsage[];
  exitReason?: string;
}

// ─── Agent Context ───────────────────────────────────────────────

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AgentContext {
  /** Agent identity */
  agentId: string;
  role: string;
  namespace: string;

  /** Execution */
  prompt: string;
  model?: string;
  tools?: string[];
  maxIterations?: number;
  workDir?: string;

  /** Coordination */
  incubatorUrl: string;
  mcpServers?: Record<string, McpServerConfig>;

  /** Extra env (user-provided) */
  env?: Record<string, string>;

  /** Verbose logging */
  verbose?: boolean;
}

// ─── Hook System ─────────────────────────────────────────────────

export type HookPoint = 'PreToolUse' | 'PostToolUse' | 'PreIteration' | 'PostIteration' | 'OnError';

export interface HookContext {
  agentId: string;
  role: string;
  iteration: number;
}

export interface PreToolUsePayload {
  toolName: string;
  args: Record<string, unknown>;
}

export interface PreToolUseResult {
  /** Block tool execution. Provide a string to return as the tool result. */
  block?: string;
  /** Modified args to pass to the tool. */
  args?: Record<string, unknown>;
}

export interface PostToolUsePayload {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
}

export interface PostToolUseResult {
  /** Replacement result string. */
  result?: string;
}

export interface PreIterationPayload {
  messages: unknown[];
  totalTokens: number;
}

export interface PreIterationResult {
  /** Block iteration (stop agent). */
  block?: string;
  /** Inject additional context. */
  inject?: string;
}

export interface PostIterationPayload {
  content: string | null;
  hasToolCalls: boolean;
  usage: TokenUsage;
  totalTokens: number;
}

export interface PostIterationResult {
  /** Force stop the agent. */
  stop?: string;
}

export interface OnErrorPayload {
  error: Error;
  phase: string;
}

export interface OnErrorResult {
  /** If true, swallow the error and continue. */
  recover?: boolean;
}

/** Type-safe hook payload/result mapping */
export interface HookPayloadMap {
  PreToolUse: { payload: PreToolUsePayload; result: PreToolUseResult | void };
  PostToolUse: { payload: PostToolUsePayload; result: PostToolUseResult | void };
  PreIteration: { payload: PreIterationPayload; result: PreIterationResult | void };
  PostIteration: { payload: PostIterationPayload; result: PostIterationResult | void };
  OnError: { payload: OnErrorPayload; result: OnErrorResult | void };
}

export interface AgentHook<T extends HookPoint = HookPoint> {
  name: string;
  point: T;
  /** Lower priority runs first. Default: 100. */
  priority?: number;
  handler: (
    ctx: HookContext,
    payload: HookPayloadMap[T]['payload'],
  ) => Promise<HookPayloadMap[T]['result']> | HookPayloadMap[T]['result'];
}

// ─── Agent Events ────────────────────────────────────────────────

export type AgentEventType =
  | 'spawn'
  | 'ready'
  | 'iteration_start'
  | 'tool_start'
  | 'tool_end'
  | 'iteration_end'
  | 'sleep'
  | 'wake'
  | 'complete'
  | 'stop'
  | 'error';

export interface AgentEvent {
  type: AgentEventType;
  agentId: string;
  role: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export type EventHandler = (event: AgentEvent) => void;

// ─── Unified Agent Interface ─────────────────────────────────────

export interface UnifiedAgent {
  readonly id: string;
  readonly role: string;
  readonly type: 'worker' | 'drone' | 'claude' | 'mock';
  readonly status: AgentStatus;

  run(ctx: AgentContext): Promise<AgentResult>;
  stop(reason?: string): Promise<void>;

  addHook(hook: AgentHook): void;
  removeHook(name: string): void;

  on(event: AgentEventType, handler: EventHandler): void;
  off(event: AgentEventType, handler: EventHandler): void;
}
