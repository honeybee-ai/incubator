import type { AgentConfig, AgentMode, AgentResult, ProviderConfig, WakeOnConfig } from './types.js';
import type { ToolClient } from './tool-client.js';
import type { ProtocolResponse } from './acp/runtime.js';
import { AcpRuntime } from './acp/runtime.js';
import { AgentRunner } from './runner.js';
import { NativeToolClient } from './native-client.js';
import { McpToolClient, connectPropolis, connectIncubatorMcp } from './mcp-client.js';
import { loadGuard } from '../propolis/guard.js';
import { resolveProvider, checkConnection, checkModel } from './providers.js';

export interface AgentOptions {
  agentId?: string;
  role?: string;
  provider: string | ProviderConfig;
  mode?: AgentMode;
  workDir?: string;
  propolisTarget?: string;
  serverUrl?: string;
  namespace?: string;
  maxIterations?: number;
  temperature?: number;
  verbose?: boolean;
  noAcp?: boolean;
  noAcpInject?: boolean;
  toolFilter?: string[] | null;
  coordination?: string | string[];
  startOn?: { conditions: Array<{ event: string; count: number }>; timeout: number } | null;
  wakeOn?: WakeOnConfig | null;
  noGuard?: boolean;
}

/**
 * High-level Agent class.
 * Use createWorker() or createDrone() for convenience.
 */
export class Agent {
  private config: AgentConfig;
  private runner = new AgentRunner();
  private toolClient: ToolClient | null = null;
  private incubatorClient: ToolClient | null = null;
  private runtime: AcpRuntime | null = null;
  private noGuard: boolean;

  constructor(options: AgentOptions) {
    const provider = typeof options.provider === 'string'
      ? resolveProvider(options.provider)
      : options.provider;

    const mode: AgentMode = options.mode ?? 'worker';

    this.config = {
      agentId: options.agentId ?? `agent_${Date.now().toString(36)}`,
      role: options.role ?? 'developer',
      provider,
      mode,
      serverUrl: options.serverUrl ?? 'http://localhost:3100',
      namespace: options.namespace ?? 'default',
      maxIterations: options.maxIterations ?? 50,
      temperature: options.temperature,
      verbose: options.verbose ?? false,
      workDir: options.workDir ?? process.cwd(),
      propolisTarget: options.propolisTarget,
      noAcp: options.noAcp ?? false,
      noAcpInject: options.noAcpInject,
      toolFilter: options.toolFilter,
      coordination: options.coordination,
      startOn: options.startOn ?? null,
      wakeOn: options.wakeOn ?? null,
    };

    this.noGuard = options.noGuard ?? false;
  }

  async run(protocolOverride?: ProtocolResponse | null): Promise<AgentResult> {
    try {
      // Create tool client based on mode
      if (this.config.mode === 'worker') {
        const guard = this.noGuard ? null : loadGuard(this.config.verbose);
        this.toolClient = new NativeToolClient(
          this.config.workDir!,
          guard,
          this.config.verbose,
          this.config.toolFilter,
        );
      } else {
        // Drone mode — connect via MCP
        const target = this.config.propolisTarget ?? 'stdio:--work-dir=.';
        this.toolClient = await connectPropolis(target);
      }

      // Set up ACP
      if (!this.config.noAcp) {
        this.runtime = new AcpRuntime({
          serverUrl: this.config.serverUrl,
          namespace: this.config.namespace,
          agentId: this.config.agentId,
          role: this.config.role,
          maxIterations: this.config.maxIterations,
          verbose: this.config.verbose,
          useWebSocket: !!this.config.wakeOn,
        });
      } else {
        // --no-acp: Connect to incubator via MCP
        try {
          this.incubatorClient = await connectIncubatorMcp(this.config.serverUrl, this.config.namespace);
        } catch {
          // Continue without incubator
        }
      }

      return await this.runner.run(
        this.config,
        this.toolClient,
        this.incubatorClient,
        this.runtime,
        protocolOverride,
      );
    } finally {
      await this.cleanup();
    }
  }

  stop(): void {
    this.runner.stop();
  }

  private async cleanup(): Promise<void> {
    if (this.toolClient) await this.toolClient.close();
    if (this.incubatorClient) await this.incubatorClient.close();
    if (this.runtime) await this.runtime.disconnect();
  }
}

/**
 * Create a Worker agent (in-process Propolis tools, no MCP overhead).
 */
export function createWorker(options: Omit<AgentOptions, 'mode'>): Agent {
  return new Agent({ ...options, mode: 'worker' });
}

/**
 * Create a Drone agent (MCP-connected Propolis tools).
 */
export function createDrone(options: Omit<AgentOptions, 'mode'>): Agent {
  return new Agent({ ...options, mode: 'drone' });
}

// Re-exports for the main entry point
export type { AgentConfig, AgentMode, AgentResult, ProviderConfig, ToolDef, TokenUsage, WakeOnConfig } from './types.js';
export type { ToolClient } from './tool-client.js';
export type { ProtocolResponse } from './acp/runtime.js';
export { AgentRunner, DroneRunner } from './runner.js';
export { NativeToolClient } from './native-client.js';
export { McpToolClient } from './mcp-client.js';
export { AcpRuntime } from './acp/runtime.js';
export { resolveProvider } from './providers.js';
