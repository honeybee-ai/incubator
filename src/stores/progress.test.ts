import { describe, it, expect } from 'vitest';
import { ProgressStore } from './progress.js';

describe('ProgressStore', () => {
  function setup() {
    return new ProgressStore();
  }

  it('reports progress for a claim', async () => {
    const store = setup();
    const report = await store.report('task-1', 'agent_1', 0.5, 'halfway done');
    expect(report.claim).toBe('task-1');
    expect(report.agent).toBe('agent_1');
    expect(report.progress).toBe(0.5);
    expect(report.note).toBe('halfway done');
    expect(report.updatedAt).toBeDefined();
  });

  it('gets a progress report by claim', async () => {
    const store = setup();
    await store.report('task-1', 'agent_1', 0.3);
    const result = await store.get('task-1');
    expect(result).not.toBeNull();
    expect(result!.progress).toBe(0.3);
  });

  it('returns null for unknown claim', async () => {
    const store = setup();
    const result = await store.get('nonexistent');
    expect(result).toBeNull();
  });

  it('updates progress on subsequent reports', async () => {
    const store = setup();
    await store.report('task-1', 'agent_1', 0.3);
    await store.report('task-1', 'agent_1', 0.7, 'almost there');
    const result = await store.get('task-1');
    expect(result!.progress).toBe(0.7);
    expect(result!.note).toBe('almost there');
  });

  it('clamps progress above 1 to 1', async () => {
    const store = setup();
    const report = await store.report('task-1', 'agent_1', 1.5);
    expect(report.progress).toBe(1);
  });

  it('clamps progress below 0 to 0', async () => {
    const store = setup();
    const report = await store.report('task-1', 'agent_1', -0.1);
    expect(report.progress).toBe(0);
  });

  it('lists all progress reports', async () => {
    const store = setup();
    await store.report('task-1', 'agent_1', 0.5);
    await store.report('task-2', 'agent_2', 0.8);
    await store.report('task-3', 'agent_1', 0.1);
    const all = await store.list();
    expect(all.length).toBe(3);
  });

  it('returns empty list initially', async () => {
    const store = setup();
    const all = await store.list();
    expect(all).toEqual([]);
  });

  it('report without note leaves note undefined', async () => {
    const store = setup();
    const report = await store.report('task-1', 'agent_1', 0.5);
    expect(report.note).toBeUndefined();
  });
});
