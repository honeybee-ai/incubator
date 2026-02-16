/**
 * Unified Agent Interface — barrel export.
 */
export type {
  UnifiedAgent,
  AgentStatus,
  AgentContext,
  AgentResult,
  AgentHook,
  AgentEvent,
  AgentEventType,
  EventHandler,
  HookPoint,
  HookContext,
  McpServerConfig,
  PreToolUsePayload,
  PreToolUseResult,
  PostToolUsePayload,
  PostToolUseResult,
  PreIterationPayload,
  PreIterationResult,
  PostIterationPayload,
  PostIterationResult,
  OnErrorPayload,
  OnErrorResult,
  HookPayloadMap,
} from './types.js';

export { HookEngine } from './hooks.js';
export { BaseAgent } from './base-agent.js';
export { WorkerAgent, type WorkerAgentDeps } from './worker-agent.js';
export { MockAgent, type MockAgentDeps } from './mock-agent.js';
export { ClaudeAgent, type ClaudeAgentOptions } from './claude-agent.js';
export { createAgent, type FactoryContext } from './factory.js';
export { createLoopDetectionHook, type LoopDetectionOptions } from './loop-detection-hook.js';
