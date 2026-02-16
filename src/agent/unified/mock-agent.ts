/**
 * MockAgent — wraps existing runMockAgent() for the UnifiedAgent interface.
 *
 * Deterministic action sequences without LLM calls.
 */
import { BaseAgent } from './base-agent.js';
import type { AgentContext, AgentResult } from './types.js';
import { runMockAgent } from '../mock-runner.js';
import type { MockBehavior } from '../../orchestrator.js';
import type { AgentConfig } from '../types.js';
import type { ToolClient } from '../tool-client.js';
import type { DirectRuntime } from '../acp/direct-runtime.js';
import type { TelemetryReporter } from '@honeybee-ai/hivemind-sdk/telemetry';

export interface MockAgentDeps {
  behavior: MockBehavior;
  toolClient?: ToolClient | null;
  runtime?: DirectRuntime | null;
  telemetry?: TelemetryReporter;
}

export class MockAgent extends BaseAgent {
  readonly type = 'mock' as const;
  private deps: MockAgentDeps;
  private stopped = false;

  constructor(id: string, role: string, deps: MockAgentDeps) {
    super(id, role);
    this.deps = deps;
  }

  async run(ctx: AgentContext): Promise<AgentResult> {
    this._status = 'running';
    this.emit('spawn', { type: 'mock' });

    const config: AgentConfig = {
      agentId: this.id,
      role: this.role,
      provider: { type: 'ollama', baseUrl: '', model: 'mock' },
      serverUrl: ctx.incubatorUrl,
      namespace: ctx.namespace,
      maxIterations: this.deps.behavior.maxIterations ?? this.deps.behavior.actions.length,
      verbose: ctx.verbose ?? false,
      mode: 'worker',
      workDir: ctx.workDir,
      noAcp: false,
    };

    this.emit('ready');

    try {
      const mockResult = await runMockAgent(
        this.deps.behavior,
        config,
        this.deps.toolClient ?? null,
        this.deps.runtime ?? null,
        this.deps.telemetry,
      );

      const result: AgentResult = {
        agentId: mockResult.agentId,
        role: mockResult.role,
        status: mockResult.status === 'error' ? 'error' : 'completed',
        iterations: mockResult.iterations,
        error: mockResult.error,
        usage: mockResult.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };

      this._status = this.stopped ? 'stopped' : (result.status === 'error' ? 'error' : 'stopped');
      this.emit(result.status === 'error' ? 'error' : 'complete', {
        iterations: result.iterations,
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
    this.stopped = true;
    this._status = 'stopped';
    this.emit('stop', { reason });
  }
}
