/**
 * ClaudeAgent — wraps @anthropic-ai/claude-agent-sdk query() for UnifiedAgent.
 *
 * Dynamic import: SDK is an optional dependency.
 * Falls back to error if SDK is not installed.
 */
import { BaseAgent } from './base-agent.js';
import type { AgentContext, AgentResult } from './types.js';
import type { TokenUsage } from '../types.js';

export interface ClaudeAgentOptions {
  /** Path to Claude Code ACP plugin directory (mcp-server.js). */
  pluginDir?: string;
  /** Allowed tools for the SDK query. */
  allowedTools?: string[];
  /** Max turns for the SDK query. */
  maxTurns?: number;
}

export class ClaudeAgent extends BaseAgent {
  readonly type = 'claude' as const;
  private options: ClaudeAgentOptions;
  private aborted = false;

  constructor(id: string, role: string, options: ClaudeAgentOptions = {}) {
    super(id, role);
    this.options = options;
  }

  async run(ctx: AgentContext): Promise<AgentResult> {
    this._status = 'running';
    this.emit('spawn', { type: 'claude' });

    // Dynamic import — graceful error if SDK not installed
    let queryFn: any;
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      queryFn = sdk.query;
    } catch {
      this._status = 'error';
      const errMsg = '@anthropic-ai/claude-agent-sdk is not installed. Install it to use type: claude agents.';
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

    this.emit('ready');

    const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let iterations = 0;

    try {
      // Build MCP servers config
      const mcpServers: Record<string, { command: string; args?: string[] }> = {
        ...(ctx.mcpServers ?? {}),
      };

      // Add ACP plugin if pluginDir specified
      if (this.options.pluginDir) {
        const { join } = await import('node:path');
        mcpServers.acp = {
          command: 'node',
          args: [join(this.options.pluginDir, 'mcp-server.js')],
        };
      }

      for await (const message of queryFn({
        prompt: ctx.prompt,
        options: {
          allowedTools: this.options.allowedTools ?? ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          permissionMode: 'bypassPermissions',
          maxTurns: this.options.maxTurns ?? ctx.maxIterations ?? 100,
          cwd: ctx.workDir,
          model: ctx.model,
          env: {
            ...ctx.env,
            INCUBATOR_URL: ctx.incubatorUrl,
            ACP_NAMESPACE: ctx.namespace,
            ACP_AGENT_ID: ctx.agentId,
            ACP_ROLE: ctx.role,
          },
          mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
        },
      })) {
        if (this.aborted) break;

        iterations++;
        this.emit('iteration_start', { iteration: iterations });

        // Extract text from structured messages
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if ('text' in block) {
              // Log output (truncated)
              this.emit('iteration_end', {
                iteration: iterations,
                text: (block.text as string).slice(0, 200),
              });
            }
          }
        }
      }

      this._status = this.aborted ? 'stopped' : 'stopped';
      this.emit('complete', { iterations });

      return {
        agentId: this.id,
        role: this.role,
        status: this.aborted ? 'stopped' : 'completed',
        iterations,
        usage,
      };
    } catch (err) {
      this._status = 'error';
      const errMsg = err instanceof Error ? err.message : String(err);
      this.emit('error', { error: errMsg });
      return {
        agentId: this.id,
        role: this.role,
        status: 'error',
        iterations,
        error: errMsg,
        usage,
      };
    }
  }

  async stop(reason?: string): Promise<void> {
    this.aborted = true;
    this._status = 'stopped';
    this.emit('stop', { reason });
  }
}
