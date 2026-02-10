import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { NotificationBus } from './bus.js';
import type { IRunStore } from './stores/interfaces.js';

export interface AgentSpec {
  role: string;
  count?: number;
  /** 'worker' = in-process tools (default), 'drone' = MCP tools */
  type?: 'worker' | 'drone';
  tools?: string[] | 'all';
  coordination?: string | string[];
  modelHint?: string | null;
  startOn?: { conditions: Array<{ event: string; count: number }>; timeout: number } | null;
}

export interface AgentsConfig {
  provider: string;
  stagger: number;
  noAcp: boolean;
  propolisPort: number;
  worktree: string;
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
}

interface ChildInfo {
  pid: number;
  agentId: string;
  role: string;
  type: 'propolis' | 'drone' | 'worker';
}

/**
 * Spawns and manages agent child processes within a single hive.
 *
 * Worker agents: single process each (in-process tools, no propolis needed).
 * Drone agents: propolis process + drone processes (MCP tools over HTTP).
 */
export class BroodOrchestrator {
  private children = new Map<string, ChildProcess>();
  private childInfo: ChildInfo[] = [];
  private propolisPid?: number;

  constructor(
    private config: AgentsConfig,
    private incubatorPort: number,
    private bus?: NotificationBus,
    private runs?: IRunStore,
    private verbose = false,
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
    const hasDrones = this.config.agents.some(a => a.type === 'drone');
    const hasWorkers = this.config.agents.some(a => !a.type || a.type === 'worker');

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

  private async spawnAgents(): Promise<void> {
    const { propolisPort, worktree } = this.config;
    const config = this.config;
    let agentIndex = 0;

    for (const agent of config.agents) {
      const count = agent.count ?? 1;
      const agentType = agent.type ?? 'worker';

      for (let i = 0; i < count; i++) {
        const staggerMs = config.stagger * 1000;
        if (agentIndex > 0 && staggerMs > 0) {
          await sleep(staggerMs);
        }
        agentIndex++;

        const suffix = randomBytes(3).toString('hex');
        const agentId = `${agent.role}_${suffix}`;

        // Provider resolution chain: modelHint → models[role] → provider → default
        const providerShorthand =
          (agent.modelHint && config.models?.[agent.modelHint])
          ?? config.models?.[agent.role]
          ?? config.provider
          ?? 'ollama/qwen3:8b';

        const agentArgs = [
          `--server=http://localhost:${this.incubatorPort}`,
          `--namespace=default`,
          `--agent-id=${agentId}`,
          `--role=${agent.role}`,
          `--provider=${providerShorthand}`,
          '--verbose',
        ];

        if (agentType === 'worker') {
          // Worker mode: in-process tools, specify work-dir
          agentArgs.push(`--mode=worker`);
          agentArgs.push(`--work-dir=${worktree}`);
        } else {
          // Drone mode: MCP tools, connect to shared propolis
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

        const childEnv: Record<string, string> = {
          ...process.env as Record<string, string>,
          ...config.env,
        };

        const child = spawn(process.execPath, [this.hiveEntry, ...agentArgs], {
          env: childEnv,
          cwd: worktree,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        child.stderr?.on('data', (data: Buffer) => {
          const line = data.toString().trim();
          if (line) this.log(`[${agentId}] ${line}`);
        });

        child.on('exit', (code) => {
          this.children.delete(`${agentType}:${agentId}`);
          const status = code === 0 ? 'completed' : `exited with code ${code}`;
          this.log(`[${agentId}] ${status}`);
        });

        if (child.pid) {
          this.children.set(`${agentType}:${agentId}`, child);
          this.childInfo.push({ pid: child.pid, agentId, role: agent.role, type: agentType });
          this.log(`${agentType === 'worker' ? 'Worker' : 'Drone'} ${agentId} (${agent.role}) started → ${providerShorthand} (pid ${child.pid})`);
        }
      }
    }
  }

  /** Get info about spawned agents. */
  getAgents(): ChildInfo[] {
    return [...this.childInfo];
  }

  /** Graceful shutdown: SIGTERM agents → propolis. */
  async shutdown(): Promise<void> {
    this.log('Shutting down agents...');

    // Kill agents first (workers and drones)
    for (const [key, child] of this.children) {
      if (key.startsWith('drone:') || key.startsWith('worker:')) {
        child.kill('SIGTERM');
        this.log(`Stopped ${key}`);
      }
    }

    // Small delay for agents to clean up, then kill propolis
    await sleep(500);
    const propolis = this.children.get('propolis');
    if (propolis) {
      propolis.kill('SIGTERM');
      this.log('Stopped propolis');
    }

    this.children.clear();
    this.childInfo = [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
