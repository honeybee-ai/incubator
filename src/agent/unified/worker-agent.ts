/**
 * WorkerAgent — wraps existing AgentRunner for the UnifiedAgent interface.
 *
 * The runner itself is unmodified. This adapter:
 * - Maps AgentContext → AgentConfig
 * - Manages lifecycle (idle → running → stopped/completed)
 * - Fires events at key points
 * - Runs hooks are available via the hook engine (not yet wired into runner internals)
 */
import { BaseAgent } from './base-agent.js';
import type { AgentContext, AgentResult } from './types.js';
import { AgentRunner } from '../runner.js';
import type { AgentConfig, TokenUsage } from '../types.js';
import type { ToolClient } from '../tool-client.js';
import type { AcpRuntime } from '../acp/runtime.js';
import type { DirectRuntime } from '../acp/direct-runtime.js';
import type { ProtocolResponse } from '../acp/runtime.js';
import type { TelemetryReporter } from '@honeybee-ai/hivemind-sdk/telemetry';

export interface WorkerAgentDeps {
  toolClient: ToolClient;
  incubatorClient?: ToolClient | null;
  runtime?: AcpRuntime | DirectRuntime | null;
  protocolOverride?: ProtocolResponse | null;
  telemetry?: TelemetryReporter;
  /** Provider config resolved externally */
  provider: import('../types.js').ProviderConfig;
}

export class WorkerAgent extends BaseAgent {
  readonly type = 'worker' as const;
  private runner: AgentRunner;
  private deps: WorkerAgentDeps;

  constructor(id: string, role: string, deps: WorkerAgentDeps) {
    super(id, role);
    this.runner = new AgentRunner();
    this.deps = deps;
  }

  async run(ctx: AgentContext): Promise<AgentResult> {
    this._status = 'running';
    this.emit('spawn', { type: 'worker' });

    const config: AgentConfig = {
      agentId: this.id,
      role: this.role,
      provider: this.deps.provider,
      serverUrl: ctx.incubatorUrl,
      namespace: ctx.namespace,
      maxIterations: ctx.maxIterations ?? 50,
      verbose: ctx.verbose ?? false,
      mode: 'worker',
      workDir: ctx.workDir,
      noAcp: false,
      toolFilter: ctx.tools ?? null,
      prompt: ctx.prompt,
    };

    this.emit('ready');

    try {
      const runnerResult = await this.runner.run(
        config,
        this.deps.toolClient,
        this.deps.incubatorClient ?? null,
        this.deps.runtime ?? null,
        this.deps.protocolOverride,
        this.deps.telemetry,
      );

      const result: AgentResult = {
        agentId: runnerResult.agentId,
        role: runnerResult.role,
        status: runnerResult.status === 'error' ? 'error' : 'completed',
        iterations: runnerResult.iterations,
        error: runnerResult.error,
        usage: runnerResult.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        iterationUsage: runnerResult.iterationUsage,
      };

      this._status = result.status === 'error' ? 'error' : 'stopped';
      this.emit(result.status === 'error' ? 'error' : 'complete', {
        iterations: result.iterations,
        exitReason: result.status,
      });

      return result;
    } catch (err) {
      this._status = 'error';
      const errMsg = err instanceof Error ? err.message : String(err);
      this.emit('error', { error: errMsg });
      return {
        agentId: this.id,
        role: this.role,
        status: 'error',
        iterations: 0,
        error: errMsg,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    }
  }

  async stop(reason?: string): Promise<void> {
    this.runner.stop();
    this._status = 'stopped';
    this.emit('stop', { reason });
  }
}
