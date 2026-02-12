/**
 * Mock agent runner — deterministic action sequences without LLM calls.
 * Used for testing all agent tiers (drone, worker, queen) with real stores/tools.
 */
import type { AgentResult, AgentConfig, TokenUsage } from './types.js';
import type { ToolClient } from './tool-client.js';
import type { DirectRuntime } from './acp/direct-runtime.js';
import type { TelemetryReporter } from '@honeybee-ai/hivemind-sdk/telemetry';
import type { MockAction, MockBehavior } from '../orchestrator.js';

/**
 * Run a mock agent that executes a scripted sequence of tool calls.
 * No LLM is involved — the "intelligence" is the action script.
 */
export async function runMockAgent(
  behavior: MockBehavior,
  config: AgentConfig,
  toolClient: ToolClient | null,
  runtime: DirectRuntime | null,
  telemetry?: TelemetryReporter,
): Promise<AgentResult> {
  const actions = behavior.actions;
  const maxIterations = behavior.maxIterations ?? actions.length;
  const iterationDelay = behavior.iterationDelay ?? 0;

  let iterations = 0;
  let lastResult: unknown = null;
  let error: string | undefined;

  for (let i = 0; i < maxIterations; i++) {
    if (actions.length === 0) break;

    const action = actions[i % actions.length];
    const opStart = Date.now();

    try {
      // Resolve $last templates in args
      const resolvedArgs = resolveTemplates(action.args, lastResult);

      // Dispatch to appropriate handler
      const result = await dispatchTool(action.tool, resolvedArgs, toolClient, runtime);
      lastResult = result;

      telemetry?.record('tool_call', {
        agentId: config.agentId,
        tool: action.tool,
        success: true,
        latency_ms: Date.now() - opStart,
        mock: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telemetry?.record('tool_call', {
        agentId: config.agentId,
        tool: action.tool,
        success: false,
        error: msg,
        latency_ms: Date.now() - opStart,
        mock: true,
      });
      error = msg;
      // Continue with remaining actions — don't abort on first error
    }

    iterations++;

    if (iterationDelay > 0 && i < maxIterations - 1) {
      await new Promise(r => setTimeout(r, iterationDelay));
    }
  }

  telemetry?.record('agent_complete', {
    agentId: config.agentId,
    role: config.role,
    iterations,
    exitReason: error ? 'error' : 'completed',
    mock: true,
  });

  return {
    agentId: config.agentId,
    role: config.role,
    status: error ? 'error' : 'completed',
    iterations,
    error,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

// ─── ACP tool names ─────────────────────────────────────────────

const ACP_TOOLS = new Set(['publish', 'claim', 'release', 'get_state', 'set_state']);

// ─── Tool dispatch ──────────────────────────────────────────────

async function dispatchTool(
  toolName: string,
  args: Record<string, unknown>,
  toolClient: ToolClient | null,
  runtime: DirectRuntime | null,
): Promise<unknown> {
  // ACP tools → runtime
  if (ACP_TOOLS.has(toolName) && runtime) {
    return dispatchAcpTool(toolName, args, runtime);
  }

  // Dance tools → runtime
  if (runtime && toolName.startsWith('dance:')) {
    const danceTool = toolName.slice(6);
    return runtime.callDanceTool(danceTool, args);
  }

  // Check if it's a dance tool without prefix
  if (runtime) {
    try {
      const result = await runtime.callDanceTool(toolName, args);
      return result;
    } catch {
      // Not a dance tool — fall through to env tools
    }
  }

  // Env tools → toolClient (propolis)
  if (toolClient && toolClient.hasToolName(toolName)) {
    const resultStr = await toolClient.callTool(toolName, args);
    try {
      return JSON.parse(resultStr);
    } catch {
      return resultStr;
    }
  }

  throw new Error(`Unknown tool: ${toolName}`);
}

async function dispatchAcpTool(
  toolName: string,
  args: Record<string, unknown>,
  runtime: DirectRuntime,
): Promise<unknown> {
  switch (toolName) {
    case 'publish':
      return runtime.publishEvent(args.type as string, (args.data as Record<string, unknown>) ?? {});
    case 'claim':
      return runtime.claimResource(args.resource as string, args.value as string | undefined);
    case 'release':
      return runtime.releaseResource(args.resource as string);
    case 'get_state':
      return runtime.getState();
    case 'set_state':
      return runtime.setState(args.key as string, args.value);
    default:
      throw new Error(`Unknown ACP tool: ${toolName}`);
  }
}

// ─── Template resolution ────────────────────────────────────────

/**
 * Resolve $last.field templates in args.
 * $last refers to the previous tool call's result.
 * $last.foo.bar navigates nested objects.
 */
function resolveTemplates(
  args: Record<string, unknown>,
  lastResult: unknown,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    resolved[key] = resolveValue(value, lastResult);
  }
  return resolved;
}

function resolveValue(value: unknown, lastResult: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('$last')) {
    return resolveLastPath(value, lastResult);
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return resolveTemplates(value as Record<string, unknown>, lastResult);
  }
  if (Array.isArray(value)) {
    return value.map(v => resolveValue(v, lastResult));
  }
  return value;
}

function resolveLastPath(template: string, lastResult: unknown): unknown {
  if (template === '$last') return lastResult;

  const path = template.slice(6); // Remove '$last.'
  const parts = path.split('.');
  let current: unknown = lastResult;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}
