import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Agent, createWorker, createDrone } from './agent.js';

// These tests verify Agent construction and configuration, not the full run loop
// (which is covered by runner.test.ts).

describe('Agent', () => {
  it('creates with default options', () => {
    const agent = new Agent({
      provider: 'ollama/qwen3:8b',
    });
    expect(agent).toBeDefined();
  });

  it('creates worker with explicit mode', () => {
    const agent = new Agent({
      provider: 'ollama/qwen3:8b',
      mode: 'worker',
      workDir: '/tmp/test',
    });
    expect(agent).toBeDefined();
  });

  it('creates drone with explicit mode', () => {
    const agent = new Agent({
      provider: 'ollama/qwen3:8b',
      mode: 'drone',
      propolisTarget: 'http://localhost:3200',
    });
    expect(agent).toBeDefined();
  });

  it('accepts ProviderConfig object', () => {
    const agent = new Agent({
      provider: { type: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3:8b' },
    });
    expect(agent).toBeDefined();
  });
});

describe('createWorker', () => {
  it('returns Agent configured in worker mode', () => {
    const agent = createWorker({
      provider: 'ollama/qwen3:8b',
      workDir: '/tmp/test',
    });
    expect(agent).toBeInstanceOf(Agent);
  });
});

describe('createDrone', () => {
  it('returns Agent configured in drone mode', () => {
    const agent = createDrone({
      provider: 'ollama/qwen3:8b',
      propolisTarget: 'http://localhost:3200',
    });
    expect(agent).toBeInstanceOf(Agent);
  });
});
