// ─── Shared types (from SDK) ────────────────────────────────────────
export type {
  ProviderConfig,
  ChatMessage,
  ToolCall,
  ToolDef,
  TokenUsage,
  CompletionResult,
} from '@honeybee-ai/hivemind-sdk/providers';

export type { CompletionOptions } from '@honeybee-ai/hivemind-sdk/providers';

// ─── Incubator-specific types ───────────────────────────────────────

export interface StartOnCondition {
  event: string;
  count: number;
}

export interface StartOnConfig {
  conditions: StartOnCondition[];
  timeout: number;
}

export interface WakeOnConfig {
  /** Event types to wake on. null = any event. */
  types?: string[] | null;
  /** Milliseconds between wakes. 0 = wait forever. */
  timeout?: number;
  /** Maximum wake cycles. 0 = unlimited. */
  maxWakes?: number;
}

export type AgentMode = 'worker' | 'drone';

export interface AgentConfig {
  agentId: string;
  role: string;
  provider: import('@honeybee-ai/hivemind-sdk/providers').ProviderConfig;
  serverUrl: string;
  namespace: string;
  protocolPath?: string;
  maxIterations: number;
  temperature?: number;
  verbose: boolean;
  /** Agent mode: 'worker' (in-process tools) or 'drone' (MCP tools) */
  mode: AgentMode;
  /** Propolis connection string for drone mode: "stdio:--work-dir=/tmp" or "http://localhost:3200" */
  propolisTarget?: string;
  /** Working directory for worker mode (propolis tools run in-process) */
  workDir?: string;
  /** If true, connect to incubator via MCP and expose tools to LLM (benchmarking mode) */
  noAcp: boolean;
  /** If true, disable ACP injection but still connect to incubator for synthetic tools */
  noAcpInject?: boolean;
  /** Propolis tool name whitelist. null = no filtering (all tools). */
  toolFilter?: string[] | null;
  /** Incubator tool filtering in no-ACP mode: 'lite'|'full'|'none' or array of names. */
  coordination?: string | string[];
  /** Wait for events before entering the ReAct loop. */
  startOn?: StartOnConfig | null;
  /** Sleep/wake cycle configuration for reactive agents. */
  wakeOn?: WakeOnConfig | null;
  /** Maximum cumulative tokens across all wake cycles. 0 = unlimited. */
  maxTotalTokens?: number;
  /** Maximum wall clock runtime in milliseconds. 0 = unlimited. */
  maxRuntime?: number;
  /** Maximum LLM call retries per iteration. Default: 3. */
  maxRetries?: number;
  /** Context window size override (tokens). Derived from provider if not set. */
  contextWindow?: number;
  /** Custom prompt injected as the initial user message. */
  prompt?: string | null;
  /** Number of peer agents (for bootstrap negotiation when no protocol is loaded). */
  peerCount?: number;
}

/** Backwards-compatible alias */
export type DroneConfig = AgentConfig;

export type AgentStatus = 'idle' | 'running' | 'completed' | 'error';

export interface AgentResult {
  agentId: string;
  role: string;
  status: AgentStatus;
  iterations: number;
  error?: string;
  usage?: import('@honeybee-ai/hivemind-sdk/providers').TokenUsage;
  /** Per-iteration token counts for detailed analysis */
  iterationUsage?: import('@honeybee-ai/hivemind-sdk/providers').TokenUsage[];
}
