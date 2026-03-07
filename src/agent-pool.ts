/**
 * AgentPool — runs worker agents as async loops inside the incubator process.
 * Replaces child process spawning for worker-type agents.
 */
import { randomBytes } from 'node:crypto';
import type { Stores } from './stores/interfaces.js';
import type { NotificationBus } from './bus.js';
import type { NamespaceRegistry } from './namespaces.js';
import type { DanceModule } from './dances.js';
import type { ProtocolResponse } from './agent/acp/runtime.js';
import type { AgentResult, AgentConfig } from './agent/types.js';
import type { AgentSpec, MockBehavior } from './orchestrator.js';
import { runMockAgent } from './agent/mock-runner.js';
import { DirectRuntime, type DirectRuntimeConfig } from './agent/acp/direct-runtime.js';
import { AgentRunner } from './agent/runner.js';
import { NativeToolClient } from './agent/native-client.js';
import { LoggingToolClient } from './agent/logging-client.js';
import type { ToolClient } from './agent/tool-client.js';
import type { ToolDef } from './agent/types.js';
import { resolveProvider } from './agent/providers.js';
import type { Guard } from './propolis/guard.js';
import type { PluginManager } from './plugins/index.js';

/** No-op tool client when plugins provide no tool entries. */
class NullToolClient implements ToolClient {
  getToolDefs(): ToolDef[] { return []; }
  hasToolName(): boolean { return false; }
  async callTool(_name: string): Promise<string> { return JSON.stringify({ error: 'No tool client available' }); }
  async close(): Promise<void> {}
}
import type { ProtocolSpec } from '@agentcoordinationprotocol/spec';
import type { TelemetryReporter } from '@honeybee-ai/hivemind-sdk/telemetry';

export interface PoolContext {
  stores: Stores;
  bus: NotificationBus;
  registry: NamespaceRegistry;
  namespace: string;
  workDir: string;
  guard: Guard | null;
  verbose: boolean;
  danceModule?: DanceModule;
  protocolData?: ProtocolResponse;
  provider: string;
  models?: Record<string, string>;
  telemetry?: TelemetryReporter;
  pluginManager?: PluginManager;
  /** FSBackend for memfs workspace mode (opaque, passed to PluginManager). */
  fsBackend?: unknown;
  /** Apiary remote shell config for memfs+VPS mode (opaque, passed to PluginManager). */
  remoteShell?: unknown;
  /** Path to write coordination JSONL log (experiment tracing). */
  coordinationLog?: string;
}

interface PoolAgent {
  promise: Promise<AgentResult>;
  runner: AgentRunner | null;
  runtime: DirectRuntime;
  agentId: string;
  role: string;
}

export class AgentPool {
  private agents = new Map<string, PoolAgent>();
  /** Callback fired when any agent promise settles (for completion detection). */
  onExit?: (agentId: string, error?: Error) => void;

  async startAgent(spec: AgentSpec, ctx: PoolContext): Promise<string> {
    const suffix = randomBytes(3).toString('hex');
    const agentId = `${spec.role}_${suffix}`;

    // Resolve provider
    const providerShorthand =
      (spec.modelHint && ctx.models?.[spec.modelHint])
      ?? ctx.models?.[spec.role]
      ?? ctx.provider
      ?? 'ollama/qwen3:8b';
    const provider = resolveProvider(providerShorthand);

    // Build protocol data from registry spec
    const protocolData = ctx.protocolData ?? this.buildProtocolData(ctx.registry, ctx.namespace, spec.role);

    // Create DirectRuntime
    const maxIter = spec.maxIterations ?? 50;
    const runtimeConfig: DirectRuntimeConfig = {
      stores: ctx.stores,
      bus: ctx.bus,
      namespace: ctx.namespace,
      agentId,
      role: spec.role,
      maxIterations: maxIter,
      verbose: ctx.verbose,
      danceModule: ctx.danceModule,
      protocolData: protocolData ?? undefined,
      registry: ctx.registry,
      coordinationLog: ctx.coordinationLog,
    };
    const runtime = new DirectRuntime(runtimeConfig);

    // Query peer count for bootstrap prompt
    const assignments = await ctx.stores.roles.getAssignments();
    const peerCount = assignments.length;

    // Create tool client from PluginManager entries.
    // If fsBackend is provided (memfs mode), rebuild entries with backend injected.
    const toolFilter = spec.tools && spec.tools !== 'all' ? spec.tools : null;
    let toolClient: NativeToolClient | null = null;
    if (ctx.pluginManager?.hasToolEntries() || ctx.fsBackend) {
      if ((ctx.fsBackend || ctx.remoteShell) && ctx.pluginManager) {
        // Per-agent tool entries with memfs backend (+ optional remote shell)
        ctx.pluginManager.buildToolEntries(ctx.workDir, ctx.guard, ctx.verbose, ctx.fsBackend, ctx.remoteShell);
      }
      if (ctx.pluginManager?.hasToolEntries()) {
        toolClient = new NativeToolClient(ctx.pluginManager.getToolEntries(), toolFilter);
      }
    }

    // Build agent config
    const config: AgentConfig = {
      agentId,
      role: spec.role,
      provider,
      serverUrl: `direct://localhost`,
      namespace: ctx.namespace,
      maxIterations: maxIter,
      verbose: ctx.verbose,
      mode: 'worker',
      workDir: ctx.workDir,
      noAcp: false,
      toolFilter,
      coordination: spec.coordination,
      startOn: spec.startOn ?? null,
      wakeOn: spec.wakeOn ?? null,
      prompt: spec.prompt,
      peerCount,
    };

    ctx.telemetry?.record('agent_spawn', {
      agentId, role: spec.role, provider: providerShorthand, type: 'worker', inProcess: true,
    });

    // Start agent as async loop
    const runner = new AgentRunner();
    let effectiveToolClient: ToolClient = toolClient ?? new NullToolClient();
    if (ctx.telemetry) {
      effectiveToolClient = new LoggingToolClient(effectiveToolClient, ctx.telemetry, agentId, spec.role);
    }
    const promise = runner.run(config, effectiveToolClient, null, runtime, protocolData, ctx.telemetry)
      .finally(() => {
        runtime.disconnect().catch(() => {});
        effectiveToolClient.close().catch(() => {});
      });

    // Log agent crashes visibly (the original was fire-and-forget with zero error output)
    promise.catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[agent-pool] Agent ${agentId} (${spec.role}) crashed: ${msg}`);
      ctx.telemetry?.record('agent_error', { agentId, role: spec.role, error: msg });
    });

    // Notify exit callback on settlement (success or failure)
    promise.then(
      () => { this.onExit?.(agentId); },
      (err: unknown) => { this.onExit?.(agentId, err instanceof Error ? err : new Error(String(err))); },
    );

    this.agents.set(agentId, { promise, runner, runtime, agentId, role: spec.role });

    return agentId;
  }

  async startMockAgent(spec: AgentSpec, behavior: MockBehavior, ctx: PoolContext): Promise<string> {
    const suffix = randomBytes(3).toString('hex');
    const agentId = `${spec.role}_${suffix}`;

    // Build protocol data
    const protocolData = ctx.protocolData ?? this.buildProtocolData(ctx.registry, ctx.namespace, spec.role);

    // Create DirectRuntime
    const runtimeConfig: DirectRuntimeConfig = {
      stores: ctx.stores,
      bus: ctx.bus,
      namespace: ctx.namespace,
      agentId,
      role: spec.role,
      maxIterations: behavior.maxIterations ?? behavior.actions.length,
      verbose: ctx.verbose,
      danceModule: ctx.danceModule,
      protocolData: protocolData ?? undefined,
      registry: ctx.registry,
    };
    const runtime = new DirectRuntime(runtimeConfig);

    // Create tool client from PluginManager entries (if available)
    const toolFilter = spec.tools && spec.tools !== 'all' ? spec.tools : null;
    let toolClient: ToolClient | null = null;
    if (ctx.pluginManager?.hasToolEntries()) {
      toolClient = new NativeToolClient(ctx.pluginManager.getToolEntries(), toolFilter);
    }

    // Build mock agent config
    const mockConfig: AgentConfig = {
      agentId,
      role: spec.role,
      provider: { type: 'ollama', baseUrl: '', model: 'mock' },
      serverUrl: 'direct://localhost',
      namespace: ctx.namespace,
      maxIterations: behavior.maxIterations ?? behavior.actions.length,
      verbose: ctx.verbose,
      mode: 'worker',
      workDir: ctx.workDir,
      noAcp: false,
    };

    const promise = runMockAgent(behavior, mockConfig, toolClient, runtime, ctx.telemetry).finally(() => {
      runtime.disconnect().catch(() => {});
      toolClient?.close().catch(() => {});
    });

    // Notify exit callback on settlement
    promise.then(
      () => { this.onExit?.(agentId); },
      (err: unknown) => { this.onExit?.(agentId, err instanceof Error ? err : new Error(String(err))); },
    );

    this.agents.set(agentId, { promise, runner: null, runtime, agentId, role: spec.role });

    return agentId;
  }

  async killAgent(agentId: string, telemetry?: { record(type: string, meta: Record<string, unknown>): void }): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.runner?.stop();
    telemetry?.record('agent_kill', { agentId, reason: 'pool_kill' });
    // Wait briefly for cleanup
    try {
      await Promise.race([agent.promise, new Promise(r => setTimeout(r, 5000))]);
    } catch { /* ignore */ }
    this.agents.delete(agentId);
  }

  async shutdown(telemetry?: { record(type: string, meta: Record<string, unknown>): void }): Promise<void> {
    telemetry?.record('pool_shutdown', { agentCount: this.agents.size });
    for (const agent of this.agents.values()) {
      agent.runner?.stop();
    }
    // Wait for all agents to finish (with timeout)
    const promises = [...this.agents.values()].map(a => a.promise.catch(() => {}));
    await Promise.race([
      Promise.all(promises),
      new Promise(r => setTimeout(r, 10000)),
    ]);
    this.agents.clear();
  }

  getAgents(): Array<{ agentId: string; role: string; type: 'worker' }> {
    return [...this.agents.values()].map(a => ({
      agentId: a.agentId,
      role: a.role,
      type: 'worker' as const,
    }));
  }

  async waitForAll(): Promise<AgentResult[]> {
    const results: AgentResult[] = [];
    for (const agent of this.agents.values()) {
      try {
        results.push(await agent.promise);
      } catch (err) {
        results.push({
          agentId: agent.agentId,
          role: agent.role,
          status: 'error',
          iterations: 0,
          error: (err as Error).message,
        });
      }
    }
    return results;
  }

  get size(): number {
    return this.agents.size;
  }

  private buildProtocolData(registry: NamespaceRegistry, namespace: string, role: string): ProtocolResponse | null {
    const spec = registry.getProtocol(namespace);
    if (!spec) return null;
    return specToProtocolResponse(spec, role);
  }
}

/** Convert ProtocolSpec (from registry) to ProtocolResponse (for agent runner). */
function specToProtocolResponse(spec: ProtocolSpec, role: string): ProtocolResponse | null {
  const roleNames = Object.keys(spec.roles);
  const roleName = roleNames.includes(role) ? role : roleNames[0];
  const roleDef = spec.roles[roleName];
  if (!roleDef) return null;

  const phases: Record<string, { description: string; terminal?: boolean }> = {};
  for (const [name, def] of Object.entries(spec.phases)) {
    phases[name] = { description: def.description, ...(def.terminal ? { terminal: true } : {}) };
  }
  const phaseNames = Object.keys(phases);

  // Extract rules for this role
  const roleRules = spec.rules?.[roleName];
  const rules: Record<string, { loop?: boolean; steps: Array<{ action: string; description?: string; hint?: string; params?: Record<string, unknown> }> }> = {};
  if (roleRules) {
    for (const [phase, rule] of Object.entries(roleRules)) {
      const r = rule as { loop?: boolean; steps: Array<{ action: string; description?: string; hint?: string; params?: Record<string, unknown> }> };
      rules[phase] = r;
    }
  }

  // Extract wait, context, temperature from role definition
  const raw = roleDef as unknown as Record<string, unknown>;
  const wait = raw.wait as { types?: string[]; max_timeout?: number } | undefined;
  const context = raw.context as number | undefined;
  const temperature = raw.temperature as number | undefined;
  const reasoning = raw.reasoning as boolean | undefined;

  return {
    protocol: { name: spec.name, title: spec.title },
    role: { name: roleName, description: roleDef.description },
    current_phase: phaseNames[0] ?? 'default',
    instructions: `Follow the ${spec.title} protocol as the ${roleName} role.`,
    phases,
    ...(spec.governance ? { governance: spec.governance as Record<string, unknown> } : {}),
    ...(Object.keys(rules).length > 0 ? { rules } : {}),
    ...(spec.resources ? { resources: spec.resources as unknown as Record<string, unknown> } : {}),
    ...(wait ? { wait } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}
