import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NotificationBus } from './bus.js';
import type { Stores, IRunStore } from './stores/interfaces.js';
import type { NamespaceRegistry } from './namespaces.js';
import type { DanceModule } from './dances.js';
import { AgentPool, type PoolContext } from './agent-pool.js';
import type { TelemetryReporter } from '@honeybee-ai/hivemind-sdk/telemetry';
import type { PluginManager } from './plugins/index.js';
import type { SessionStore } from './sessions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Path to the bundled Claude Code ACP plugin (shipped with incubator). */
const PLUGIN_DIR = join(__dirname, '..', 'plugin');

export interface MockAction {
  tool: string;
  args: Record<string, unknown>;
  response?: string;
}

export interface MockBehavior {
  actions: MockAction[];
  maxIterations?: number;
  iterationDelay?: number;
}

export interface AgentSpec {
  role: string;
  count?: number;
  /** 'worker' = in-process tools (default), 'drone' = MCP tools, 'claude' = Claude Code instance, 'mock' = scripted test agent */
  type?: 'worker' | 'drone' | 'claude' | 'mock';
  tools?: string[] | 'all';
  coordination?: string | string[];
  modelHint?: string | null;
  /** Custom prompt for claude agents. */
  prompt?: string | null;
  /** Path to a Claude Code plugin directory (--plugin-dir). */
  pluginDir?: string | null;
  startOn?: { conditions: Array<{ event: string; count: number }>; timeout: number } | null;
  wakeOn?: { types?: string[] | null; timeout?: number; maxWakes?: number } | null;
  /** Mock behavior for type: 'mock' agents. */
  mock?: MockBehavior | null;
  /** Workspace backend: 'memfs' for in-memory filesystem, 'real' for disk (default). */
  workspace?: 'memfs' | 'real';
}

/** Apiary VPS config for remote shell bridging. */
export interface ApiaryConfig {
  url: string;       // "http://apiary.honeyb.dev:3300"
  repo?: string;     // git clone URL
  branch?: string;   // git branch (default: main)
  setup?: string;    // post-clone setup command (e.g. "pnpm install")
}

export interface AgentsConfig {
  provider: string;
  stagger: number;
  noAcp: boolean;
  propolisPort: number;
  worktree: string;
  /** Target namespace for agent coordination (default: 'default'). */
  namespace?: string;
  /** When true, use https:// for INCUBATOR_URL. */
  tls?: boolean;
  /** Unified hive entry point (replaces droneEntry + propolisEntry) */
  hiveEntry: string;
  /** @deprecated Use hiveEntry. Kept for backwards compat with older CLI. */
  droneEntry?: string;
  /** @deprecated Use hiveEntry. Kept for backwards compat with older CLI. */
  propolisEntry?: string;
  protocolPath?: string;
  agents: AgentSpec[];
  models?: Record<string, string>;
  env?: Record<string, string>;
  /** Apiary VPS config for memfs remote shell. Secret comes from APIARY_SECRET env. */
  apiary?: ApiaryConfig;
}

export interface AgentInfo {
  pid?: number;
  agentId: string;
  role: string;
  type: 'propolis' | 'drone' | 'worker' | 'claude';
  inProcess?: boolean;
}

/**
 * Spawns and manages agent child processes within a single hive.
 *
 * Worker agents: run in-process via AgentPool (no child process).
 * Drone agents: propolis process + drone processes (MCP tools over HTTP).
 * Claude agents: Claude Code instances as child processes.
 */
export class BroodOrchestrator {
  private children = new Map<string, ChildProcess>();
  private childInfo: AgentInfo[] = [];
  private propolisPid?: number;
  private pool?: AgentPool;
  /** MemFS instances keyed by agentId (for changeset extraction). */
  private memfsInstances = new Map<string, unknown>();
  /** Apiary workspace IDs created during this session (for cleanup). */
  private workspaceIds = new Set<string>();

  /** Path to write coordination JSONL log (experiment tracing). */
  coordinationLog?: string;

  constructor(
    private config: AgentsConfig,
    private incubatorPort: number,
    private bus?: NotificationBus,
    private runs?: IRunStore,
    private verbose = false,
    private stores?: Stores,
    private registry?: NamespaceRegistry,
    private danceModule?: DanceModule,
    private telemetry?: TelemetryReporter,
    private pluginManager?: PluginManager,
    private sessionStore?: SessionStore,
  ) {}

  private log(msg: string): void {
    if (this.verbose) {
      console.error(`[orchestrator] ${msg}`);
    }
  }

  /** Resolve hive entry point (supports old droneEntry/propolisEntry for backwards compat) */
  private get hiveEntry(): string {
    return this.config.hiveEntry ?? this.config.droneEntry ?? '';
  }

  /** Resolve propolis entry (from hive package or legacy propolisEntry) */
  private get propolisEntry(): string {
    if (this.config.propolisEntry) return this.config.propolisEntry;
    // Hive package: propolis entry is at the propolis subpath
    // The CLI resolves this, but we can derive it from hiveEntry
    return this.config.hiveEntry ?? '';
  }

  async start(): Promise<void> {
    this.telemetry?.record('protocol_start', {
      agentCount: this.config.agents.reduce((n, a) => n + (a.count ?? 1), 0),
      provider: this.config.provider,
    });

    const hasDrones = this.config.agents.some(a => a.type === 'drone');

    // 1. Spawn propolis only if there are drone agents
    if (hasDrones) {
      await this.spawnPropolis();
      await sleep(1500);
    }

    // 2. Spawn agents with stagger
    await this.spawnAgents();
  }

  private async spawnPropolis(): Promise<void> {
    const entry = this.propolisEntry;
    const { propolisPort, worktree, env } = this.config;

    const args = ['--http', `--port=${propolisPort}`, `--work-dir=${worktree}`, '--no-guard'];
    const childEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...env,
    };

    const child = spawn(process.execPath, [entry, ...args], {
      env: childEnv,
      cwd: worktree,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) this.log(`[propolis] ${line}`);
    });

    child.on('exit', (code) => {
      this.children.delete('propolis');
      if (code !== null && code !== 0) {
        this.log(`Propolis exited with code ${code}`);
      }
    });

    if (child.pid) {
      this.children.set('propolis', child);
      this.propolisPid = child.pid;
      this.log(`Propolis started on port ${propolisPort} (pid ${child.pid})`);
    }
  }

  /** Check if in-process mode is available (stores injected). */
  private get canRunInProcess(): boolean {
    return !!(this.stores && this.bus && this.registry);
  }

  private async spawnAgents(): Promise<void> {
    const { propolisPort, worktree } = this.config;
    const config = this.config;
    let agentIndex = 0;

    // Build pool context if we can run workers in-process
    let poolCtx: PoolContext | undefined;
    if (this.canRunInProcess) {
      this.pool = new AgentPool();
      const ns = this.config.namespace ?? 'default';
      poolCtx = {
        stores: this.stores!,
        bus: this.bus!,
        registry: this.registry!,
        namespace: ns,
        workDir: worktree,
        guard: null,
        verbose: this.verbose,
        danceModule: this.danceModule,
        provider: config.provider,
        models: config.models,
        telemetry: this.telemetry,
        pluginManager: this.pluginManager,
        coordinationLog: this.coordinationLog,
      };
    }

    for (const agent of config.agents) {
      const count = agent.count ?? 1;
      const agentType = agent.type ?? 'worker';

      for (let i = 0; i < count; i++) {
        const staggerMs = config.stagger * 1000;
        if (agentIndex > 0 && staggerMs > 0) {
          await sleep(staggerMs);
        }
        agentIndex++;

        if (agentType === 'mock') {
          if (this.pool && poolCtx) {
            const agentId = await this.pool.startMockAgent(agent, agent.mock ?? { actions: [] }, poolCtx);
            this.childInfo.push({ agentId, role: agent.role, type: 'worker', inProcess: true });
            this.sessionStore?.register(agentId, agent.role);
            this.telemetry?.record('agent_spawn', {
              agentId, role: agent.role, type: 'mock', inProcess: true,
            });
            this.log(`Mock ${agentId} (${agent.role}) started in-process`);
          } else {
            this.log(`Mock agent ${agent.role} skipped — no in-process pool available`);
          }
          continue;
        }

        if (agentType === 'claude') {
          const suffix = randomBytes(3).toString('hex');
          const agentId = `${agent.role}_${suffix}`;
          // Try Agent SDK first (programmatic), fall back to subprocess
          const usedSdk = await this.startClaudeAgent(agent, agentId, config);
          if (!usedSdk) {
            this.spawnClaude(agent, agentId, config);
          }
          continue;
        }

        // Workers run in-process when pool is available
        if (agentType === 'worker' && this.pool && poolCtx) {
          // Build per-agent pool context (with optional memfs + remote shell)
          let agentPoolCtx = poolCtx;
          if (agent.workspace === 'memfs') {
            const memfs = await this.createMemFS(worktree);
            agentPoolCtx = { ...poolCtx, fsBackend: memfs };

            // If apiary is configured, create a workspace and enable remote shell
            if (config.apiary) {
              const remoteShell = await this.createApiaryWorkspace(config.apiary, agent.role);
              if (remoteShell) {
                agentPoolCtx = { ...agentPoolCtx, remoteShell };
              }
            }
          }

          const agentId = await this.pool.startAgent(agent, agentPoolCtx);
          this.childInfo.push({ agentId, role: agent.role, type: 'worker', inProcess: true });
          // Register in session store so REST anti-spoofing knows this ID is taken
          this.sessionStore?.register(agentId, agent.role);

          // Store memfs reference for changeset extraction
          if (agent.workspace === 'memfs' && agentPoolCtx.fsBackend) {
            this.memfsInstances.set(agentId, agentPoolCtx.fsBackend);
          }

          const providerShorthand =
            (agent.modelHint && config.models?.[agent.modelHint])
            ?? config.models?.[agent.role]
            ?? config.provider
            ?? 'ollama/qwen3:8b';
          this.telemetry?.record('agent_spawn', {
            agentId, role: agent.role, provider: providerShorthand, type: 'worker', inProcess: true,
            workspace: agent.workspace ?? 'real',
          });
          this.log(`Worker ${agentId} (${agent.role}) started in-process${agent.workspace === 'memfs' ? ' [memfs]' : ''} → ${providerShorthand}`);
          continue;
        }

        // Spawn as child process (drone, or worker when pool unavailable)
        const suffix = randomBytes(3).toString('hex');
        const agentId = `${agent.role}_${suffix}`;

        // Provider resolution chain: modelHint → models[role] → provider → default
        const providerShorthand =
          (agent.modelHint && config.models?.[agent.modelHint])
          ?? config.models?.[agent.role]
          ?? config.provider
          ?? 'ollama/qwen3:8b';

        const serverProto = config.tls ? 'https' : 'http';
        const ns = config.namespace ?? 'default';
        const agentArgs = [
          `--server=${serverProto}://localhost:${this.incubatorPort}`,
          `--namespace=${ns}`,
          `--agent-id=${agentId}`,
          `--role=${agent.role}`,
          `--provider=${providerShorthand}`,
          '--verbose',
        ];

        if (agentType === 'worker') {
          agentArgs.push(`--mode=worker`);
          agentArgs.push(`--work-dir=${worktree}`);
        } else {
          agentArgs.push(`--mode=drone`);
          agentArgs.push(`--propolis=http://localhost:${propolisPort}`);
        }

        if (config.protocolPath) {
          agentArgs.push(`--protocol=${config.protocolPath}`);
        }

        if (config.noAcp) {
          agentArgs.push('--no-acp');
        }

        if (agent.tools && agent.tools !== 'all') {
          agentArgs.push(`--tools=${agent.tools.join(',')}`);
        }
        if (agent.coordination) {
          const val = Array.isArray(agent.coordination)
            ? agent.coordination.join(',')
            : agent.coordination;
          agentArgs.push(`--coordination=${val}`);
        }
        if (agent.startOn) {
          agentArgs.push(`--start-on=${JSON.stringify(agent.startOn)}`);
        }
        if (agent.wakeOn) {
          agentArgs.push(`--wake-on=${JSON.stringify(agent.wakeOn)}`);
        }

        const childEnv: Record<string, string> = {
          ...process.env as Record<string, string>,
          ...config.env,
          ...(config.tls ? { NODE_TLS_REJECT_UNAUTHORIZED: '0' } : {}),
        };

        // Register agent in session store and pass token (anti-spoofing)
        if (this.sessionStore) {
          const token = this.sessionStore.register(agentId, agent.role);
          childEnv['ACP_SESSION_TOKEN'] = token;
        }

        // Pass custom prompt via env var (avoids shell escaping for multi-line prompts)
        if (agent.prompt) {
          childEnv['AGENT_PROMPT'] = agent.prompt;
        }

        const child = spawn(process.execPath, [this.hiveEntry, ...agentArgs], {
          env: childEnv,
          cwd: worktree,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stderr?.on('data', (data: Buffer) => {
          const line = data.toString().trim();
          if (line) this.log(`[${agentId}] ${line}`);
        });

        child.on('exit', (code, signal) => {
          this.children.delete(`${agentType}:${agentId}`);
          const status = code === 0 ? 'completed' : `exited with code ${code}`;
          this.log(`[${agentId}] ${status}`);
          this.telemetry?.record('agent_exit', {
            agentId, role: agent.role, type: agentType, exitCode: code, signal,
          });
        });

        if (child.pid) {
          this.children.set(`${agentType}:${agentId}`, child);
          this.childInfo.push({ pid: child.pid, agentId, role: agent.role, type: agentType });
          this.telemetry?.record('agent_spawn', {
            agentId, role: agent.role, provider: providerShorthand, type: agentType, pid: child.pid,
          });
          this.log(`${agentType === 'worker' ? 'Worker' : 'Drone'} ${agentId} (${agent.role}) started → ${providerShorthand} (pid ${child.pid})`);
        }
      }
    }
  }

  /**
   * Start a Claude agent using the Agent SDK (programmatic, no subprocess).
   * Returns true if SDK was available and agent was started, false to fall back.
   */
  private async startClaudeAgent(agent: AgentSpec, agentId: string, config: AgentsConfig): Promise<boolean> {
    let queryFn: any;
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      queryFn = sdk.query;
    } catch {
      // Agent SDK not installed — fall back to subprocess
      return false;
    }

    const prompt = agent.prompt
      ?? `You are assigned the role "${agent.role}" in an ACP coordination protocol. Use the acp MCP tool to coordinate with other agents. Follow the protocol instructions injected at session start.`;

    const pluginDir = agent.pluginDir ?? PLUGIN_DIR;

    // Model hint resolution
    const modelHint =
      (agent.modelHint && config.models?.[agent.modelHint])
      ?? config.models?.[agent.role]
      ?? agent.modelHint
      ?? undefined;

    const agentPromise = (async () => {
      try {
        for await (const message of queryFn({
          prompt,
          options: {
            allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
            permissionMode: 'bypassPermissions',
            maxTurns: 100,
            cwd: config.worktree,
            model: modelHint ?? undefined,
            env: {
              INCUBATOR_URL: `${config.tls ? 'https' : 'http'}://localhost:${this.incubatorPort}`,
              ACP_NAMESPACE: config.namespace ?? 'default',
              ACP_AGENT_ID: agentId,
              ACP_ROLE: agent.role,
              ...(agent.wakeOn?.types ? { ACP_WAKE_ON: agent.wakeOn.types.join(',') } : {}),
              ...(this.sessionStore ? { ACP_SESSION_TOKEN: this.sessionStore.register(agentId, agent.role) } : {}),
              ...config.env,
            },
            mcpServers: {
              acp: { command: 'node', args: [join(pluginDir, 'mcp-server.js')] },
            },
          },
        })) {
          // Structured message handling
          if (message.type === 'assistant' && message.message?.content) {
            for (const block of message.message.content) {
              if ('text' in block) {
                this.log(`[${agentId}] ${block.text.slice(0, 200)}`);
              }
            }
          }
        }
      } catch (err) {
        this.log(`[${agentId}] Agent SDK error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
      this.telemetry?.record('agent_exit', {
        agentId, role: agent.role, type: 'claude', exitCode: 0, signal: null,
      });
    })();

    this.childInfo.push({ agentId, role: agent.role, type: 'claude', inProcess: true });
    this.telemetry?.record('agent_spawn', {
      agentId, role: agent.role, type: 'claude', inProcess: true, sdk: true,
    });
    this.log(`Claude ${agentId} (${agent.role}) started via Agent SDK`);

    return true;
  }

  /**
   * Spawn a Claude Code instance with ACP coordination env vars.
   * Claude Code's native tools handle the env side; the ACP plugin handles coordination.
   */
  private spawnClaude(agent: AgentSpec, agentId: string, config: AgentsConfig): void {
    const { worktree } = config;

    // Model hint for Claude: maps to --model flag
    const modelHint =
      (agent.modelHint && config.models?.[agent.modelHint])
      ?? config.models?.[agent.role]
      ?? agent.modelHint
      ?? undefined;

    // Build prompt from role (custom prompt overrides default)
    const prompt = agent.prompt
      ?? `You are assigned the role "${agent.role}" in an ACP coordination protocol. Use the acp MCP tool to coordinate with other agents. Follow the protocol instructions injected at session start.`;

    // Resolve plugin directory: explicit config > bundled default
    const pluginDir = agent.pluginDir ?? PLUGIN_DIR;

    const claudeArgs = ['--print', '--dangerously-skip-permissions', '-p', prompt, '--plugin-dir', pluginDir];
    if (modelHint) {
      claudeArgs.push('--model', modelHint);
    }

    // ACP coordination env vars — the claude-acp plugin reads these
    const childEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...config.env,
      INCUBATOR_URL: `${config.tls ? 'https' : 'http'}://localhost:${this.incubatorPort}`,
      ...(config.tls ? { NODE_TLS_REJECT_UNAUTHORIZED: '0' } : {}),
      ACP_NAMESPACE: config.namespace ?? 'default',
      ACP_AGENT_ID: agentId,
      ACP_ROLE: agent.role,
    };

    // Register agent in session store and pass token (anti-spoofing)
    if (this.sessionStore) {
      const token = this.sessionStore.register(agentId, agent.role);
      childEnv['ACP_SESSION_TOKEN'] = token;
    }

    if (agent.wakeOn?.types) {
      childEnv['ACP_WAKE_ON'] = agent.wakeOn.types.join(',');
    }

    const child = spawn('claude', claudeArgs, {
      env: childEnv,
      cwd: worktree,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) this.log(`[${agentId}:out] ${line}`);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) this.log(`[${agentId}:err] ${line}`);
    });

    child.on('exit', (code, signal) => {
      this.children.delete(`claude:${agentId}`);
      const status = code === 0 ? 'completed' : `exited with code ${code}`;
      this.log(`[${agentId}] ${status}`);
      this.telemetry?.record('agent_exit', {
        agentId, role: agent.role, type: 'claude', exitCode: code, signal,
      });
    });

    if (child.pid) {
      this.children.set(`claude:${agentId}`, child);
      this.childInfo.push({ pid: child.pid, agentId, role: agent.role, type: 'claude' });
      this.telemetry?.record('agent_spawn', {
        agentId, role: agent.role, type: 'claude', pid: child.pid,
      });
      this.log(`Claude ${agentId} (${agent.role}) started (pid ${child.pid})`);
    }
  }

  /** Get info about all agents (in-process + child processes). */
  getAgents(): AgentInfo[] {
    return [...this.childInfo];
  }

  /** Kill a specific agent. Pool agents: runner.stop(). Child processes: SIGTERM. */
  async killAgent(agentId: string): Promise<void> {
    // Check pool first
    if (this.pool) {
      const poolAgents = this.pool.getAgents();
      if (poolAgents.some(a => a.agentId === agentId)) {
        await this.pool.killAgent(agentId);
        this.log(`Stopped pool agent ${agentId}`);
        return;
      }
    }

    // Fall back to child process
    const child = this.children.get(`worker:${agentId}`) ?? this.children.get(`drone:${agentId}`) ?? this.children.get(`claude:${agentId}`);
    if (!child) return;
    child.kill('SIGTERM');
    this.telemetry?.record('agent_kill', { agentId, signal: 'SIGTERM' });
    this.log(`Sent SIGTERM to ${agentId}`);
    // Grace period — SIGKILL if still alive after 5s
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
        this.log(`Sent SIGKILL to ${agentId} (did not exit gracefully)`);
      }
    }, 5000);
  }

  /**
   * Create a workspace on the Apiary VPS and return RemoteShellConfig.
   * Returns null if the workspace creation fails (agent falls back to pure memfs).
   */
  private async createApiaryWorkspace(
    apiary: ApiaryConfig,
    role: string,
  ): Promise<{ apiaryUrl: string; apiarySecret: string; workspaceId: string } | null> {
    const secret = process.env['APIARY_SECRET'];
    if (!secret) {
      this.log('APIARY_SECRET not set — skipping remote shell');
      return null;
    }

    const workspaceId = `${role}-${randomBytes(4).toString('hex')}`;

    try {
      const res = await fetch(`${apiary.url}/workspaces`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workspaceId,
          source: apiary.repo ? {
            type: 'git',
            url: apiary.repo,
            branch: apiary.branch ?? 'main',
          } : undefined,
          setup: apiary.setup,
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const body = await res.text();
        this.log(`Apiary workspace creation failed (${res.status}): ${body}`);
        return null;
      }

      this.workspaceIds.add(workspaceId);
      this.log(`Apiary workspace created: ${workspaceId}`);

      return {
        apiaryUrl: apiary.url,
        apiarySecret: secret,
        workspaceId,
      };
    } catch (err) {
      this.log(`Apiary workspace creation error: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Create a MemFS instance seeded from the worktree directory.
   * Dynamic import avoids hard dep on propolis (optional).
   */
  private async createMemFS(worktree: string): Promise<unknown> {
    try {
      const { MemFS } = await import('@honeybee-ai/propolis');
      const memfs = new MemFS();
      memfs.seedFromDir(worktree);
      this.log(`MemFS seeded from ${worktree} (${memfs.fileCount} files)`);
      return memfs;
    } catch (err) {
      this.log(`Failed to create MemFS: ${(err as Error).message}`);
      throw new Error('MemFS requires @honeybee-ai/propolis to be installed');
    }
  }

  /**
   * Get the MemFS changeset for a specific agent.
   * Returns null if the agent doesn't use memfs.
   */
  getAgentChangeset(agentId: string): Map<string, string | null> | null {
    const memfs = this.memfsInstances.get(agentId);
    if (!memfs || typeof (memfs as Record<string, unknown>).getChangeset !== 'function') return null;
    return (memfs as { getChangeset(): Map<string, string | null> }).getChangeset();
  }

  /**
   * Get all MemFS changesets (agentId → changeset map).
   */
  getAllChangesets(): Map<string, Map<string, string | null>> {
    const result = new Map<string, Map<string, string | null>>();
    for (const [agentId, memfs] of this.memfsInstances) {
      if (typeof (memfs as Record<string, unknown>).getChangeset === 'function') {
        result.set(agentId, (memfs as { getChangeset(): Map<string, string | null> }).getChangeset());
      }
    }
    return result;
  }

  /** Graceful shutdown: stop pool agents → SIGTERM child processes → propolis. */
  async shutdown(): Promise<void> {
    this.telemetry?.record('protocol_end', {
      agentCount: this.childInfo.length,
      status: 'shutdown',
    });
    this.log('Shutting down agents...');

    // Stop pool agents first
    if (this.pool) {
      await this.pool.shutdown();
      this.log('Stopped all pool agents');
    }

    // Kill child process agents (drones, claude, legacy workers)
    for (const [key, child] of this.children) {
      if (key.startsWith('drone:') || key.startsWith('worker:') || key.startsWith('claude:')) {
        child.kill('SIGTERM');
        this.log(`Stopped ${key}`);
      }
    }

    // Small delay for agents to clean up, then kill propolis
    await sleep(500);
    const propolisChild = this.children.get('propolis');
    if (propolisChild) {
      propolisChild.kill('SIGTERM');
      this.log('Stopped propolis');
    }

    this.children.clear();
    this.childInfo = [];

    // Clean up Apiary workspaces
    if (this.workspaceIds.size > 0 && this.config.apiary) {
      const secret = process.env['APIARY_SECRET'];
      if (secret) {
        for (const wsId of this.workspaceIds) {
          try {
            await fetch(`${this.config.apiary.url}/workspaces/${wsId}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${secret}` },
              signal: AbortSignal.timeout(5000),
            });
            this.log(`Deleted workspace ${wsId}`);
          } catch {
            // Best effort cleanup
          }
        }
      }
      this.workspaceIds.clear();
    }

    // Clean up plugin resources (PTY sessions, temp files, etc.)
    if (this.pluginManager) {
      await this.pluginManager.destroyAll();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
