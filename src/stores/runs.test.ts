import { describe, it, expect } from 'vitest';
import { RunStore } from './runs.js';

describe('RunStore', () => {
  function setup() {
    return new RunStore();
  }

  it('starts a new run', async () => {
    const store = setup();
    const run = await store.start('agent_1', 'researcher');
    expect(run.agentId).toBe('agent_1');
    expect(run.role).toBe('researcher');
    expect(run.status).toBe('running');
    expect(run.startedAt).toBeDefined();
  });

  it('completes a run with data', async () => {
    const store = setup();
    await store.start('agent_1', 'researcher');
    const run = await store.complete('agent_1', {
      status: 'completed',
      iterations: 10,
      elapsed: 5000,
      summary: 'Done',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });
    expect(run).not.toBeNull();
    expect(run!.status).toBe('completed');
    expect(run!.iterations).toBe(10);
    expect(run!.elapsed).toBe(5000);
    expect(run!.usage!.totalTokens).toBe(150);
    expect(run!.completedAt).toBeDefined();
  });

  it('complete returns null for unknown agent', async () => {
    const store = setup();
    const run = await store.complete('nope', { status: 'completed' });
    expect(run).toBeNull();
  });

  it('defaults to completed status if run was running', async () => {
    const store = setup();
    await store.start('agent_1', 'researcher');
    const run = await store.complete('agent_1', { summary: 'Done' });
    expect(run!.status).toBe('completed');
  });

  it('get returns a run by agentId', async () => {
    const store = setup();
    await store.start('agent_1', 'researcher');
    const run = await store.get('agent_1');
    expect(run).not.toBeNull();
    expect(run!.role).toBe('researcher');
  });

  it('get returns null for unknown agent', async () => {
    const store = setup();
    const run = await store.get('nope');
    expect(run).toBeNull();
  });

  it('list returns all runs', async () => {
    const store = setup();
    await store.start('agent_1', 'researcher');
    await store.start('agent_2', 'writer');
    const runs = await store.list();
    expect(runs.length).toBe(2);
  });

  it('list filters by status', async () => {
    const store = setup();
    await store.start('agent_1', 'researcher');
    await store.start('agent_2', 'writer');
    await store.complete('agent_1', { status: 'completed' });

    const running = await store.list('running');
    expect(running.length).toBe(1);
    expect(running[0].agentId).toBe('agent_2');

    const completed = await store.list('completed');
    expect(completed.length).toBe(1);
    expect(completed[0].agentId).toBe('agent_1');
  });

  it('summary aggregates stats', async () => {
    const store = setup();
    await store.start('agent_1', 'researcher');
    await store.start('agent_2', 'writer');
    await store.start('agent_3', 'reviewer');

    await store.complete('agent_1', {
      status: 'completed',
      elapsed: 3000,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });
    await store.complete('agent_2', {
      status: 'error',
      elapsed: 1000,
      error: 'boom',
      usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
    });

    const s = await store.summary();
    expect(s.agents).toBe(3);
    expect(s.completed).toBe(1);
    expect(s.errors).toBe(1);
    expect(s.totalTokens).toBe(450);
    expect(s.totalDuration).toBe(4000);
  });

  it('summary works with empty store', async () => {
    const store = setup();
    const s = await store.summary();
    expect(s.agents).toBe(0);
    expect(s.completed).toBe(0);
    expect(s.errors).toBe(0);
    expect(s.totalTokens).toBe(0);
    expect(s.totalDuration).toBe(0);
  });

  it('halted runs count as completed in summary', async () => {
    const store = setup();
    await store.start('agent_1', 'researcher');
    await store.complete('agent_1', { status: 'halted', elapsed: 2000 });

    const s = await store.summary();
    expect(s.completed).toBe(1);
    expect(s.errors).toBe(0);
  });
});
