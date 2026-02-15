import type {
  WaggleInput, WaggleResult, OpResult, Operation,
  WaitSpec, NormalizedWait, AcpBackend, Primitives,
} from './types.js';
import type { ToolResult } from '../propolis/tools/types.js';
import type { TelemetryReporter } from '@honeybee-ai/hivemind-sdk/telemetry';
import type { PluginManager } from '../plugins/index.js';
import { resolveTemplates } from './templates.js';

// ─── Handler map ────────────────────────────────────────────────────

type EnvHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Build env handler map from PluginManager (replaces propolis-direct loading). */
export function createHandlerMap(pluginManager: PluginManager): Map<string, EnvHandler> {
  return pluginManager.getHandlerMap();
}

// ─── Context ────────────────────────────────────────────────────────

export interface CompoundContext {
  /** Map of handler name → handler function (from PluginManager). */
  handlers: Map<string, EnvHandler>;
  /** ACP backend for coordination ops (null = no coordination). */
  acp?: AcpBackend | null;
  /** Allowed primitives per role (null = all allowed). */
  primitives?: Primitives | null;
  /** Telemetry reporter (optional). */
  telemetry?: TelemetryReporter;
  /** Dynamic env action names (from PluginManager). Falls back to DEFAULT_ENV_ACTIONS. */
  envActions?: Set<string>;
}

// ─── Action name mapping ────────────────────────────────────────────

/** Map waggle action names to propolis handler names where they differ. */
const ENV_ACTION_MAP: Record<string, string> = {
  shell: 'run',
  scrape: 'scrape_page',
};

/** ACP coordination primitives. */
const ACP_ACTIONS = new Set(['publish', 'claim', 'release', 'get_state', 'set_state', 'load_protocol']);

/**
 * All known env action names.
 * Populated dynamically from PluginManager, plus waggle aliases.
 * Falls back to the classic set when no PluginManager is wired.
 */
const DEFAULT_ENV_ACTIONS = new Set([
  'read_file', 'write_file', 'patch_file', 'list_files', 'glob', 'grep',
  'shell', 'git_status', 'git_diff', 'git_commit', 'git_log',
  'fetch', 'scrape',
  'pty_spawn', 'pty_send', 'pty_read', 'pty_resize', 'pty_close',
]);

// ─── Wait normalization ─────────────────────────────────────────────

export function normalizeWait(spec: WaitSpec | undefined | false): NormalizedWait | null {
  if (spec === undefined || spec === false || spec === null) return null;
  if (spec === true) return { types: null, timeout: 0, pureDelay: false };
  if (typeof spec === 'string') return { types: [spec], timeout: 0, pureDelay: false };
  if (Array.isArray(spec)) return { types: spec.length > 0 ? spec : null, timeout: 0, pureDelay: false };
  if (typeof spec === 'number') return { types: null, timeout: spec, pureDelay: true };
  return {
    types: spec.types && spec.types.length > 0 ? spec.types : null,
    timeout: spec.timeout ?? 0,
    pureDelay: false,
  };
}

// ─── Compound handler ───────────────────────────────────────────────

export async function compoundHandler(
  input: WaggleInput,
  ctx: CompoundContext,
): Promise<WaggleResult> {
  const results: OpResult[] = [];
  let lastResult: unknown = null;

  const envActions = ctx.envActions ?? DEFAULT_ENV_ACTIONS;

  // Execute ops sequentially
  for (const rawOp of input.dance) {
    const action = rawOp.do;
    const opStart = Date.now();

    // Resolve $last templates in op args (everything except 'do')
    const opArgs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawOp)) {
      if (k !== 'do') opArgs[k] = v;
    }
    const resolved = resolveTemplates(opArgs, lastResult);
    const op: Operation = { do: action, ...resolved };

    if (ACP_ACTIONS.has(action)) {
      // Check ACP primitive filtering
      if (ctx.primitives?.acp && !ctx.primitives.acp.includes(action)) {
        results.push({ op: action, ok: false, error: `action '${action}' not permitted for this role` });
        continue;
      }
      const result = await executeAcpOp(op, ctx.acp);
      if (result.ok) lastResult = result.data;
      ctx.telemetry?.record('tool_call', { action, success: result.ok, latency_ms: Date.now() - opStart });
      results.push(result);
    } else if (envActions.has(action) || ctx.handlers.has(action) || ctx.handlers.has(ENV_ACTION_MAP[action] ?? '')) {
      // Check env primitive filtering
      if (ctx.primitives?.env && !ctx.primitives.env.includes(action)) {
        results.push({ op: action, ok: false, error: `action '${action}' not permitted for this role` });
        continue;
      }
      const result = await executeEnvOp(op, ctx.handlers, envActions);
      if (result.ok) lastResult = result.data;
      ctx.telemetry?.record('tool_call', { action, success: result.ok, latency_ms: Date.now() - opStart });
      results.push(result);
    } else {
      results.push({ op: action, ok: false, error: `unknown action: '${action}'` });
    }
  }

  // Handle wait
  const waitSpec = normalizeWait(input.wait);
  let wakeEvents: string[] | undefined;

  if (waitSpec) {
    if (waitSpec.pureDelay) {
      // Pure delay — just sleep, no event matching
      await new Promise(r => setTimeout(r, waitSpec.timeout));
      wakeEvents = [];
    } else if (ctx.acp) {
      wakeEvents = await ctx.acp.waitForWake({
        types: waitSpec.types,
        timeout: waitSpec.timeout,
      });
    } else {
      // No ACP backend — sleep if timeout, else return immediately
      if (waitSpec.timeout > 0) {
        await new Promise(r => setTimeout(r, waitSpec.timeout));
      }
      wakeEvents = [];
    }
  }

  return {
    results,
    ...(wakeEvents !== undefined ? { wakeEvents } : {}),
  };
}

// ─── Env op execution ───────────────────────────────────────────────

async function executeEnvOp(
  op: Operation,
  handlers: Map<string, EnvHandler>,
  envActions: Set<string> = DEFAULT_ENV_ACTIONS,
): Promise<OpResult> {
  const action = op.do;
  const handlerName = ENV_ACTION_MAP[action] ?? action;
  const handler = handlers.get(handlerName);

  if (!handler) {
    if (envActions.has(action)) {
      return { op: action, ok: false, error: 'Environment tools not available. Install @honeybee-ai/propolis.' };
    }
    return { op: action, ok: false, error: `unknown action: '${action}'` };
  }

  try {
    // Build args — everything except 'do'
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(op)) {
      if (k !== 'do') args[k] = v;
    }

    // Map git_diff 'cached' → 'staged' for handler compatibility
    if (action === 'git_diff' && 'cached' in args) {
      args.staged = args.cached;
      delete args.cached;
    }

    // Map git_commit 'files' array → comma-separated string
    if (action === 'git_commit' && Array.isArray(args.files)) {
      args.files = (args.files as string[]).join(',');
    }

    const result = await handler(args);
    return unwrapToolResult(action, result);
  } catch (err) {
    return { op: action, ok: false, error: (err as Error).message };
  }
}

// ─── ACP op execution ───────────────────────────────────────────────

async function executeAcpOp(
  op: Operation,
  acp?: AcpBackend | null,
): Promise<OpResult> {
  if (!acp) {
    return { op: op.do, ok: false, error: 'no ACP backend available' };
  }

  try {
    let resultStr: string;

    switch (op.do) {
      case 'publish':
        resultStr = await acp.publishEvent(
          op.type as string,
          (op.data as Record<string, unknown>) ?? {},
        );
        break;
      case 'claim':
        resultStr = await acp.claimResource(
          op.resource as string,
          op.value as string | undefined,
        );
        break;
      case 'release':
        resultStr = await acp.releaseResource(op.resource as string);
        break;
      case 'get_state':
        resultStr = await acp.getState(op.key as string | undefined);
        break;
      case 'set_state':
        resultStr = await acp.setState(op.key as string, op.value);
        break;
      case 'load_protocol':
        if (!acp.loadProtocol) {
          return { op: op.do, ok: false, error: 'load_protocol not supported by this backend' };
        }
        resultStr = await acp.loadProtocol(op.spec as string);
        break;
      default:
        return { op: op.do, ok: false, error: `unknown ACP action: '${op.do}'` };
    }

    return unwrapJsonResult(op.do, resultStr);
  } catch (err) {
    return { op: op.do, ok: false, error: (err as Error).message };
  }
}

// ─── Result unwrapping ──────────────────────────────────────────────

function unwrapToolResult(action: string, result: ToolResult): OpResult {
  const text = result.content?.[0]?.text ?? JSON.stringify(result);
  try {
    const parsed = JSON.parse(text);
    if (parsed.error) {
      return { op: action, ok: false, error: parsed.error };
    }
    return { op: action, ok: true, data: parsed };
  } catch {
    return { op: action, ok: true, data: text };
  }
}

function unwrapJsonResult(action: string, resultStr: string): OpResult {
  try {
    const parsed = JSON.parse(resultStr);
    if (parsed.error) {
      return { op: action, ok: false, error: parsed.error };
    }
    return { op: action, ok: true, data: parsed };
  } catch {
    return { op: action, ok: true, data: resultStr };
  }
}
