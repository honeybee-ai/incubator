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

export interface ProviderConfig {
  type: 'ollama' | 'openai' | 'anthropic';
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export type AgentMode = 'worker' | 'drone';

export interface AgentConfig {
  agentId: string;
  role: string;
  provider: ProviderConfig;
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
}

/** Backwards-compatible alias */
export type DroneConfig = AgentConfig;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id?: string;
  type?: 'function';
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required: string[];
    };
  };
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CompletionResult {
  message: ChatMessage;
  usage: TokenUsage;
}

export type AgentStatus = 'idle' | 'running' | 'completed' | 'error';

export interface AgentResult {
  agentId: string;
  role: string;
  status: AgentStatus;
  iterations: number;
  error?: string;
  usage?: TokenUsage;
  /** Per-iteration token counts for detailed analysis */
  iterationUsage?: TokenUsage[];
}
