export interface ProviderConfig {
  type: 'ollama' | 'openai' | 'anthropic';
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export interface AgentConfig {
  agentId: string;
  role: string;
  provider: ProviderConfig;
  serverUrl: string;
  maxIterations: number;
  temperature?: number;
}

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

export type AgentStatus = 'idle' | 'running' | 'completed' | 'error';

export interface RunnerConfig {
  defaultProvider: ProviderConfig;
  serverUrl: string;
  maxIterations: number;
  verbose: boolean;
  spawnRoles?: string[];
  /** Map model_hint values (e.g. "haiku", "sonnet", "opus") to provider configs */
  modelHintMap?: Record<string, ProviderConfig>;
}
