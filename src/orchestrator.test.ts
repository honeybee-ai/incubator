import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BroodOrchestrator, type AgentsConfig } from './orchestrator.js';

// Mock child_process.spawn
vi.mock('node:child_process', () => {
  const EventEmitter = require('node:events').EventEmitter;

  return {
    spawn: vi.fn(() => {
      const child = new EventEmitter();
      child.pid = Math.floor(Math.random() * 100000) + 1000;
      child.kill = vi.fn();
      child.stderr = new EventEmitter();
      child.stdout = new EventEmitter();
      return child;
    }),
  };
});

// Mock crypto.randomBytes
vi.mock('node:crypto', () => ({
  randomBytes: vi.fn(() => Buffer.from('abc123', 'hex')),
}));

function makeConfig(overrides?: Partial<AgentsConfig>): AgentsConfig {
  return {
    provider: 'ollama/qwen3:8b',
    stagger: 0,
    noAcp: false,
    propolisPort: 3200,
    worktree: '/tmp/test',
    hiveEntry: '/tmp/hive/dist/cli.js',
    agents: [
      { role: 'researcher', count: 2 },
      { role: 'writer' },
    ],
    ...overrides,
  };
}

describe('BroodOrchestrator', () => {
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const cp = await import('node:child_process');
    spawnMock = cp.spawn as unknown as ReturnType<typeof vi.fn>;
  });

  it('spawns workers without propolis by default', async () => {
    const config = makeConfig({ stagger: 0 });
    const orch = new BroodOrchestrator(config, 3100, undefined, undefined, false);
    await orch.start();

    // 3 workers (2 researchers + 1 writer), no propolis
    expect(spawnMock).toHaveBeenCalledTimes(3);

    // First call is a worker agent (no propolis needed)
    const workerArgs = spawnMock.mock.calls[0][1] as string[];
    expect(workerArgs.some((a: string) => a.includes('--mode=worker'))).toBe(true);
    expect(workerArgs.some((a: string) => a.includes('--role=researcher'))).toBe(true);
    expect(workerArgs.some((a: string) => a.includes('--work-dir=/tmp/test'))).toBe(true);

    await orch.shutdown();
  });

  it('spawns propolis + drones when agents have type drone', async () => {
    const config = makeConfig({
      stagger: 0,
      agents: [
        { role: 'researcher', count: 2, type: 'drone' },
        { role: 'writer', type: 'drone' },
      ],
    });
    const orch = new BroodOrchestrator(config, 3100, undefined, undefined, false);
    await orch.start();

    // 1 propolis + 3 drones
    expect(spawnMock).toHaveBeenCalledTimes(4);

    // First call is propolis
    const propolisArgs = spawnMock.mock.calls[0][1] as string[];
    expect(propolisArgs).toContain('--http');
    expect(propolisArgs.some((a: string) => a.includes('--port=3200'))).toBe(true);

    // Remaining calls are drones
    const droneArgs = spawnMock.mock.calls[1][1] as string[];
    expect(droneArgs.some((a: string) => a.includes('--role=researcher'))).toBe(true);
    expect(droneArgs.some((a: string) => a.includes('--mode=drone'))).toBe(true);
    expect(droneArgs.some((a: string) => a.includes('--propolis=http://localhost:3200'))).toBe(true);

    await orch.shutdown();
  });

  it('spawns mixed worker/drone hive correctly', async () => {
    const config = makeConfig({
      stagger: 0,
      agents: [
        { role: 'researcher', type: 'worker' },
        { role: 'writer', type: 'drone' },
      ],
    });
    const orch = new BroodOrchestrator(config, 3100, undefined, undefined, false);
    await orch.start();

    // 1 propolis + 1 worker + 1 drone = 3
    expect(spawnMock).toHaveBeenCalledTimes(3);

    // First call is propolis (because there's at least one drone)
    const propolisArgs = spawnMock.mock.calls[0][1] as string[];
    expect(propolisArgs).toContain('--http');

    // Second call is worker (spawned in order)
    const workerArgs = spawnMock.mock.calls[1][1] as string[];
    expect(workerArgs.some((a: string) => a.includes('--mode=worker'))).toBe(true);
    expect(workerArgs.some((a: string) => a.includes('--role=researcher'))).toBe(true);

    // Third call is drone
    const droneArgs = spawnMock.mock.calls[2][1] as string[];
    expect(droneArgs.some((a: string) => a.includes('--mode=drone'))).toBe(true);
    expect(droneArgs.some((a: string) => a.includes('--role=writer'))).toBe(true);

    await orch.shutdown();
  });

  it('passes --no-acp to agents when configured', async () => {
    const config = makeConfig({ noAcp: true, agents: [{ role: 'coder' }], stagger: 0 });
    const orch = new BroodOrchestrator(config, 3100, undefined, undefined, false);
    await orch.start();

    // Worker agent at index 0 (no propolis for workers)
    const agentArgs = spawnMock.mock.calls[0][1] as string[];
    expect(agentArgs).toContain('--no-acp');

    await orch.shutdown();
  });

  it('passes protocol path to agents', async () => {
    const config = makeConfig({
      protocolPath: '/tmp/test/review.acp',
      agents: [{ role: 'reviewer' }],
      stagger: 0,
    });
    const orch = new BroodOrchestrator(config, 3100, undefined, undefined, false);
    await orch.start();

    const agentArgs = spawnMock.mock.calls[0][1] as string[];
    expect(agentArgs.some((a: string) => a.includes('--protocol=/tmp/test/review.acp'))).toBe(true);

    await orch.shutdown();
  });

  it('passes tool filters to agents', async () => {
    const config = makeConfig({
      agents: [{ role: 'reader', tools: ['read_file', 'list_dir'] }],
      stagger: 0,
    });
    const orch = new BroodOrchestrator(config, 3100, undefined, undefined, false);
    await orch.start();

    const agentArgs = spawnMock.mock.calls[0][1] as string[];
    expect(agentArgs.some((a: string) => a.includes('--tools=read_file,list_dir'))).toBe(true);

    await orch.shutdown();
  });

  it('passes coordination mode to agents', async () => {
    const config = makeConfig({
      agents: [{ role: 'coder', coordination: 'lite' }],
      stagger: 0,
    });
    const orch = new BroodOrchestrator(config, 3100, undefined, undefined, false);
    await orch.start();

    const agentArgs = spawnMock.mock.calls[0][1] as string[];
    expect(agentArgs.some((a: string) => a.includes('--coordination=lite'))).toBe(true);

    await orch.shutdown();
  });

  it('passes startOn config to agents', async () => {
    const config = makeConfig({
      agents: [{
        role: 'reviewer',
        startOn: { conditions: [{ event: 'code.written', count: 3 }], timeout: 60 },
      }],
      stagger: 0,
    });
    const orch = new BroodOrchestrator(config, 3100, undefined, undefined, false);
    await orch.start();

    const agentArgs = spawnMock.mock.calls[0][1] as string[];
    const startOnArg = agentArgs.find((a: string) => a.startsWith('--start-on='));
    expect(startOnArg).toBeDefined();
    const parsed = JSON.parse(startOnArg!.replace('--start-on=', ''));
    expect(parsed.conditions[0].event).toBe('code.written');
    expect(parsed.conditions[0].count).toBe(3);

    await orch.shutdown();
  });

  it('resolves provider chain: models[role] → provider → default', async () => {
    const config = makeConfig({
      models: { writer: 'anthropic/claude-sonnet' },
      agents: [
        { role: 'writer' },
        { role: 'reviewer' },
      ],
      stagger: 0,
    });
    const orch = new BroodOrchestrator(config, 3100, undefined, undefined, false);
    await orch.start();

    // Writer gets model from models map (index 0, no propolis for workers)
    const writerArgs = spawnMock.mock.calls[0][1] as string[];
    expect(writerArgs.some((a: string) => a.includes('--provider=anthropic/claude-sonnet'))).toBe(true);

    // Reviewer gets default provider
    const reviewerArgs = spawnMock.mock.calls[1][1] as string[];
    expect(reviewerArgs.some((a: string) => a.includes('--provider=ollama/qwen3:8b'))).toBe(true);

    await orch.shutdown();
  });

  it('getAgents returns spawned agent info', async () => {
    const config = makeConfig({ agents: [{ role: 'coder', count: 2 }], stagger: 0 });
    const orch = new BroodOrchestrator(config, 3100, undefined, undefined, false);
    await orch.start();

    const agents = orch.getAgents();
    expect(agents.length).toBe(2);
    expect(agents[0].type).toBe('worker');
    expect(agents[0].role).toBe('coder');

    await orch.shutdown();
  });

  it('getAgents reports drone type for drone agents', async () => {
    const config = makeConfig({ agents: [{ role: 'coder', type: 'drone' }], stagger: 0 });
    const orch = new BroodOrchestrator(config, 3100, undefined, undefined, false);
    await orch.start();

    const agents = orch.getAgents();
    expect(agents.length).toBe(1);
    expect(agents[0].type).toBe('drone');

    await orch.shutdown();
  });

  it('shutdown sends SIGTERM to all children', async () => {
    const config = makeConfig({ agents: [{ role: 'coder', type: 'drone' }], stagger: 0 });
    const orch = new BroodOrchestrator(config, 3100, undefined, undefined, false);
    await orch.start();

    await orch.shutdown();

    // Both propolis and drone should have been killed
    for (const call of spawnMock.mock.results) {
      const child = call.value;
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    }
  });

  it('handles zero agents gracefully', async () => {
    const config = makeConfig({ agents: [] });
    const orch = new BroodOrchestrator(config, 3100, undefined, undefined, false);
    await orch.start();

    // No agents and no drones means nothing spawned
    expect(spawnMock).toHaveBeenCalledTimes(0);
    expect(orch.getAgents().length).toBe(0);

    await orch.shutdown();
  });
});
