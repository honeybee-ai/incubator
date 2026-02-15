/**
 * LoggingToolClient — decorator that records tool_call_detailed telemetry
 * events for every tool invocation from orchestrated agents.
 *
 * Wraps any ToolClient, measures timing, sanitizes args, and emits telemetry.
 */
import type { ToolClient } from './tool-client.js';
import type { ToolDef } from './types.js';
import type { TelemetryReporter } from '@honeybee-ai/hivemind-sdk/telemetry';

/** Extract shell command name from a raw command string. */
function parseShellCommand(command: string): {
  shellCommand: string;
  hasPipes: boolean;
  hasRedirects: boolean;
  hasChains: boolean;
} {
  const trimmed = command.trim();
  // First word = command name (handle leading env vars like KEY=val cmd)
  const parts = trimmed.split(/\s+/);
  let shellCommand = 'unknown';
  for (const p of parts) {
    if (p.includes('=') && !p.startsWith('-')) continue; // skip env vars
    shellCommand = p;
    break;
  }

  return {
    shellCommand,
    hasPipes: trimmed.includes(' | '),
    hasRedirects: /[^|]>[^>]|>>/.test(trimmed),
    hasChains: trimmed.includes(' && ') || trimmed.includes(' || ') || trimmed.includes(' ; '),
  };
}

/** Sanitize tool args — strip large content fields. */
function sanitizeArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'content' && typeof v === 'string') {
      safe[k] = `[${v.length} bytes]`;
    } else if (k === 'replace' && typeof v === 'string' && v.length > 100) {
      safe[k] = v.slice(0, 100) + '...';
    } else if (typeof v === 'string' && v.length > 500) {
      safe[k] = v.slice(0, 500) + '...';
    } else {
      safe[k] = v;
    }
  }
  return safe;
}

export class LoggingToolClient implements ToolClient {
  /** Set by runner each iteration for trace correlation. */
  traceId: string = '';
  /** Set by runner at start for run correlation. */
  runId: string = '';

  constructor(
    private inner: ToolClient,
    private telemetry: TelemetryReporter,
    private agentId: string,
    private role: string,
  ) {}

  getToolDefs(): ToolDef[] {
    return this.inner.getToolDefs();
  }

  hasToolName(name: string): boolean {
    return this.inner.hasToolName(name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const start = performance.now();
    let result: string;
    let success = true;
    let errorMsg: string | undefined;

    try {
      result = await this.inner.callTool(name, args);
    } catch (err) {
      success = false;
      errorMsg = (err as Error).message;
      throw err;
    } finally {
      const durationMs = Math.round(performance.now() - start);
      const sanitized = sanitizeArgs(name, args);

      const meta: Record<string, unknown> = {
        agentId: this.agentId,
        role: this.role,
        tool: name,
        args: sanitized,
        durationMs,
        resultBytes: result! !== undefined ? result!.length : 0,
        success,
      };
      if (this.runId) meta.runId = this.runId;
      if (this.traceId) meta.traceId = this.traceId;

      if (errorMsg) meta.error = errorMsg;

      // Shell-specific metadata
      if (name === 'run' && typeof args.command === 'string') {
        const shellInfo = parseShellCommand(args.command);
        meta.shellCommand = shellInfo.shellCommand;
        meta.hasPipes = shellInfo.hasPipes;
        meta.hasRedirects = shellInfo.hasRedirects;
        meta.hasChains = shellInfo.hasChains;
        // Truncate raw command for telemetry
        meta.rawCommand = args.command.length > 200
          ? args.command.slice(0, 200) + '...'
          : args.command;
      }

      this.telemetry.record('tool_call_detailed', meta);
    }

    return result!;
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}
