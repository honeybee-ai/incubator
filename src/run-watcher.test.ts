import { describe, it, expect } from 'vitest';
import { LocalBus } from './bus.js';
import { RunStore } from './stores/runs.js';
import { RunWatcher } from './run-watcher.js';

describe('RunWatcher', () => {
  function setup() {
    const bus = new LocalBus();
    const runs = new RunStore();
    const watcher = new RunWatcher(bus, runs, 'default');
    watcher.start();
    return { bus, runs, watcher };
  }

  function tick(ms = 10) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  it('creates a run on role.transition event', async () => {
    const { bus, runs, watcher } = setup();

    bus.publish('default', {
      id: 1, type: 'role.transition',
      data: { agent: 'agent_abc', from: null, to: 'researcher', reason: null },
      publishedBy: 'agent_abc', timestamp: new Date().toISOString(),
    });

    await tick();
    const run = await runs.get('agent_abc');
    expect(run).not.toBeNull();
    expect(run!.role).toBe('researcher');
    expect(run!.status).toBe('running');

    watcher.stop();
  });

  it('completes a run on agent.complete event', async () => {
    const { bus, runs, watcher } = setup();

    // First register the agent via role.transition
    bus.publish('default', {
      id: 1, type: 'role.transition',
      data: { agent: 'agent_xyz', from: null, to: 'writer', reason: null },
      publishedBy: 'agent_xyz', timestamp: new Date().toISOString(),
    });
    await tick();

    // Then complete it
    bus.publish('default', {
      id: 2, type: 'agent.complete',
      data: {
        agent: 'agent_xyz',
        summary: 'Agent agent_xyz completed after 5 iterations',
        iterations: 5,
        elapsed: 3000,
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
      publishedBy: 'agent_xyz', timestamp: new Date().toISOString(),
    });
    await tick();

    const run = await runs.get('agent_xyz');
    expect(run).not.toBeNull();
    expect(run!.status).toBe('completed');
    expect(run!.iterations).toBe(5);
    expect(run!.elapsed).toBe(3000);
    expect(run!.usage!.totalTokens).toBe(150);
    expect(run!.completedAt).toBeDefined();

    watcher.stop();
  });

  it('marks error status from summary text', async () => {
    const { bus, runs, watcher } = setup();

    bus.publish('default', {
      id: 1, type: 'role.transition',
      data: { agent: 'agent_err', from: null, to: 'worker', reason: null },
      publishedBy: 'agent_err', timestamp: new Date().toISOString(),
    });
    await tick();

    bus.publish('default', {
      id: 2, type: 'agent.complete',
      data: {
        agent: 'agent_err',
        summary: 'Error: connection refused',
        iterations: 1,
        elapsed: 500,
      },
      publishedBy: 'agent_err', timestamp: new Date().toISOString(),
    });
    await tick();

    const run = await runs.get('agent_err');
    expect(run!.status).toBe('error');
    expect(run!.error).toBe('Error: connection refused');

    watcher.stop();
  });

  it('marks halted status', async () => {
    const { bus, runs, watcher } = setup();

    bus.publish('default', {
      id: 1, type: 'role.transition',
      data: { agent: 'agent_halt', from: null, to: 'worker', reason: null },
      publishedBy: 'agent_halt', timestamp: new Date().toISOString(),
    });
    await tick();

    bus.publish('default', {
      id: 2, type: 'agent.complete',
      data: { agent: 'agent_halt', summary: 'Agent halted', iterations: 3, elapsed: 2000 },
      publishedBy: 'agent_halt', timestamp: new Date().toISOString(),
    });
    await tick();

    const run = await runs.get('agent_halt');
    expect(run!.status).toBe('halted');

    watcher.stop();
  });

  it('ignores events without agent data', async () => {
    const { bus, runs, watcher } = setup();

    bus.publish('default', {
      id: 1, type: 'agent.complete',
      data: { summary: 'no agent field' },
      publishedBy: 'system', timestamp: new Date().toISOString(),
    });
    await tick();

    const all = await runs.list();
    expect(all.length).toBe(0);

    watcher.stop();
  });

  it('ignores unrelated events', async () => {
    const { bus, runs, watcher } = setup();

    bus.publish('default', {
      id: 1, type: 'state.changed',
      data: { key: 'foo', value: 'bar' },
      publishedBy: 'agent_1', timestamp: new Date().toISOString(),
    });
    await tick();

    const all = await runs.list();
    expect(all.length).toBe(0);

    watcher.stop();
  });

  it('stop prevents further event processing', async () => {
    const { bus, runs, watcher } = setup();
    watcher.stop();

    bus.publish('default', {
      id: 1, type: 'role.transition',
      data: { agent: 'agent_after', from: null, to: 'worker', reason: null },
      publishedBy: 'agent_after', timestamp: new Date().toISOString(),
    });
    await tick();

    const all = await runs.list();
    expect(all.length).toBe(0);
  });
});
