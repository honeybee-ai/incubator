/**
 * Dance file loader — loads JS modules whose exports become virtual tools.
 * Runs entirely on the incubator (server-side).
 */
import type { ToolDef } from './agent/types.js';

// ─── Types ─────────────────────────────────────────────────────

export interface DanceToolDef {
  description: string;
  params: Record<string, { type: string; description?: string }>;
  handler: (ctx: DanceContext) => Promise<DanceResult>;
}

export interface DanceContext {
  args: Record<string, unknown>;
  state: Record<string, string>;
  agent: { role: string; agentId: string };
  acp: DanceAcpHelper;
}

export interface DanceAcpHelper {
  publish(type: string, data?: unknown): Promise<void>;
  claim(resource: string): Promise<string>;
  release(resource: string): Promise<void>;
  setState(key: string, value: string): Promise<void>;
}

export type DanceResult = { result: unknown; wait?: unknown } | { error: string };

export interface InjectFn {
  (ctx: { state: Record<string, string>; agent: { role: string; agentId: string } }): string;
}

export interface DanceTriggerDef {
  description: string;
  handler: (ctx: TriggerContext) => Promise<void>;
}

export interface TriggerContext {
  event: { type: string; data: unknown; publishedBy: string };
  state: Record<string, string>;
  acp: DanceAcpHelper;
}

export interface DanceModule {
  inject?: InjectFn;
  tools: Map<string, DanceToolDef>;
  triggers?: Map<string, DanceTriggerDef>;
}

// ─── Loader ────────────────────────────────────────────────────

/**
 * Load a dance file via dynamic import. Validates exports.
 * Returns a DanceModule with optional inject and tool map.
 */
export async function loadDances(filePath: string): Promise<DanceModule> {
  const mod = await import(filePath);
  const tools = new Map<string, DanceToolDef>();
  let inject: InjectFn | undefined;
  let triggers: Map<string, DanceTriggerDef> | undefined;

  for (const [name, exp] of Object.entries(mod)) {
    if (name === 'default') continue; // skip default export

    if (name === 'inject') {
      if (typeof exp !== 'function') {
        throw new Error(`Dance file: "inject" must be a function, got ${typeof exp}`);
      }
      inject = exp as InjectFn;
      continue;
    }

    if (name === 'triggers') {
      if (!exp || typeof exp !== 'object') {
        throw new Error('Dance file: "triggers" must be an object');
      }
      triggers = new Map<string, DanceTriggerDef>();
      for (const [tName, tDef] of Object.entries(exp as Record<string, unknown>)) {
        if (!tDef || typeof tDef !== 'object') {
          throw new Error(`Dance file: trigger "${tName}" must be an object`);
        }
        const t = tDef as Record<string, unknown>;
        if (typeof t.handler !== 'function') {
          throw new Error(`Dance file: trigger "${tName}" must have a handler function`);
        }
        if (typeof t.description !== 'string') {
          throw new Error(`Dance file: trigger "${tName}" must have a description string`);
        }
        triggers.set(tName, {
          description: t.description as string,
          handler: t.handler as DanceTriggerDef['handler'],
        });
      }
      continue;
    }

    // Everything else is a tool
    if (!exp || typeof exp !== 'object') continue;
    const tool = exp as Record<string, unknown>;

    if (typeof tool.handler !== 'function') {
      throw new Error(`Dance file: tool "${name}" must have a handler function`);
    }
    if (typeof tool.description !== 'string') {
      throw new Error(`Dance file: tool "${name}" must have a description string`);
    }

    tools.set(name, {
      description: tool.description as string,
      params: (tool.params as Record<string, { type: string; description?: string }>) ?? {},
      handler: tool.handler as DanceToolDef['handler'],
    });
  }

  return { inject, tools, triggers };
}

/**
 * Convert dance tool definitions to LLM ToolDef format.
 */
export function danceToolDefs(mod: DanceModule): ToolDef[] {
  const defs: ToolDef[] = [];
  for (const [name, tool] of mod.tools) {
    const properties: Record<string, { type: string; description: string; enum?: string[] }> = {};
    const required: string[] = [];

    for (const [param, def] of Object.entries(tool.params)) {
      properties[param] = {
        type: def.type,
        description: def.description ?? '',
      };
      required.push(param); // all params required by default
    }

    defs.push({
      type: 'function',
      function: {
        name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties,
          required,
        },
      },
    });
  }
  return defs;
}

/**
 * Build an ACP helper that wraps incubator stores for use in dance handlers.
 */
export function buildAcpHelper(stores: {
  publishEvent: (ns: string, type: string, data?: unknown, agentId?: string) => Promise<void>;
  claimResource: (ns: string, resource: string, agentId: string, ttl?: number) => Promise<string>;
  releaseResource: (ns: string, claimId: string) => Promise<void>;
  setState: (ns: string, key: string, value: string) => Promise<void>;
}, namespace: string, agentId: string): DanceAcpHelper {
  return {
    async publish(type: string, data?: unknown) {
      await stores.publishEvent(namespace, type, data, agentId);
    },
    async claim(resource: string) {
      return stores.claimResource(namespace, resource, agentId);
    },
    async release(claimId: string) {
      await stores.releaseResource(namespace, claimId);
    },
    async setState(key: string, value: string) {
      await stores.setState(namespace, key, value);
    },
  };
}

/**
 * Execute a dance tool handler with full context.
 */
export async function callDanceTool(
  mod: DanceModule,
  toolName: string,
  args: Record<string, unknown>,
  agentRole: string,
  agentId: string,
  getState: () => Promise<Record<string, string>>,
  acpHelper: DanceAcpHelper,
): Promise<DanceResult> {
  const tool = mod.tools.get(toolName);
  if (!tool) {
    return { error: `Unknown dance tool: ${toolName}` };
  }

  const state = await getState();
  const ctx: DanceContext = {
    args,
    state,
    agent: { role: agentRole, agentId },
    acp: acpHelper,
  };

  try {
    return await tool.handler(ctx);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run inject for a specific agent. Returns formatted string or null if no inject.
 */
export function runInject(
  mod: DanceModule,
  state: Record<string, string>,
  agentRole: string,
  agentId: string,
): string | null {
  if (!mod.inject) return null;
  try {
    return mod.inject({ state, agent: { role: agentRole, agentId } });
  } catch (err) {
    return `[inject error: ${err instanceof Error ? err.message : String(err)}]`;
  }
}
