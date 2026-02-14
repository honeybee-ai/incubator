/**
 * Integration tests for emergent spec negotiation.
 * Validates the load_protocol waggle op against DirectRuntime + NamespaceRegistry.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DirectRuntime, type DirectRuntimeConfig } from './agent/acp/direct-runtime.js';
import { NamespaceRegistry } from './namespaces.js';
import { LocalBus } from './bus.js';
import type { Stores } from './stores/interfaces.js';
import { generateSystemPrompt } from './agent/prompt.js';

// ─── Helpers ───────────────────────────────────────────────────────

function createWiredStores(): { stores: Stores; bus: LocalBus; registry: NamespaceRegistry } {
  const bus = new LocalBus();
  const registry = new NamespaceRegistry();
  registry.setBus(bus);
  const stores = registry.get('default');
  return { stores, bus, registry };
}

const VALID_SPEC_YAML = `
acp: "1.0"
name: emergent-collab
title: Emergent Collaboration
roles:
  leader:
    description: Coordinates the team and assigns tasks
    agents: 1
  worker:
    description: Executes assigned tasks
    agents: 2
phases:
  planning:
    description: Team discusses and plans the approach
  execution:
    description: Workers implement the plan
    exit_condition:
      event: all_tasks_complete
  review:
    description: Leader reviews all work
    terminal: true
`;

// ─── DirectRuntime.loadProtocol ─────────────────────────────────────

describe('DirectRuntime.loadProtocol', () => {
  let stores: Stores;
  let bus: LocalBus;
  let registry: NamespaceRegistry;

  beforeEach(() => {
    const wired = createWiredStores();
    stores = wired.stores;
    bus = wired.bus;
    registry = wired.registry;
  });

  function createRuntime(overrides?: Partial<DirectRuntimeConfig>): DirectRuntime {
    return new DirectRuntime({
      stores,
      bus,
      namespace: 'default',
      agentId: 'agent-1',
      role: 'leader',
      maxIterations: 10,
      registry,
      ...overrides,
    });
  }

  it('loads a valid spec into the registry', async () => {
    const runtime = createRuntime();
    const result = JSON.parse(await runtime.loadProtocol(VALID_SPEC_YAML));
    expect(result.loaded).toBe(true);
    expect(result.name).toBe('emergent-collab');
    expect(result.title).toBe('Emergent Collaboration');

    // Verify registry has the spec
    const spec = registry.getProtocol('default');
    expect(spec).toBeDefined();
    expect(spec!.name).toBe('emergent-collab');
    expect(Object.keys(spec!.roles)).toContain('leader');
    expect(Object.keys(spec!.roles)).toContain('worker');
  });

  it('returns error for invalid spec', async () => {
    const runtime = createRuntime();
    const result = JSON.parse(await runtime.loadProtocol('not_a_spec: true\nrandom: garbage'));
    expect(result.error).toBeDefined();
    expect(result.error).toContain('loadProtocol failed');
  });

  it('returns error when no registry', async () => {
    const runtime = new DirectRuntime({
      stores,
      bus,
      namespace: 'default',
      agentId: 'agent-1',
      role: 'leader',
      maxIterations: 10,
      // No registry
    });
    const result = JSON.parse(await runtime.loadProtocol(VALID_SPEC_YAML));
    expect(result.error).toContain('No registry');
  });

  it('overwrites existing protocol', async () => {
    const runtime = createRuntime();

    // Load first spec
    await runtime.loadProtocol(VALID_SPEC_YAML);
    expect(registry.getProtocol('default')?.name).toBe('emergent-collab');

    // Load a different spec
    const altSpec = VALID_SPEC_YAML.replace('emergent-collab', 'alt-protocol').replace('Emergent Collaboration', 'Alt Protocol');
    const result = JSON.parse(await runtime.loadProtocol(altSpec));
    expect(result.loaded).toBe(true);
    expect(registry.getProtocol('default')?.name).toBe('alt-protocol');
  });
});

// ─── Full negotiation flow (simulated) ──────────────────────────────

describe('negotiation flow simulation', () => {
  let stores: Stores;
  let bus: LocalBus;
  let registry: NamespaceRegistry;

  beforeEach(() => {
    const wired = createWiredStores();
    stores = wired.stores;
    bus = wired.bus;
    registry = wired.registry;
  });

  it('single agent self-specs without negotiation', async () => {
    // Agent connects, sees it's alone
    const runtime = new DirectRuntime({
      stores, bus, namespace: 'default',
      agentId: 'solo-1', role: 'worker', maxIterations: 10, registry,
    });
    await runtime.connect();

    // Agent checks peer count
    const assignments = await stores.roles.getAssignments();
    expect(assignments).toHaveLength(1);
    expect(assignments[0].agent).toBe('solo-1');

    // Agent writes and loads its own spec
    const result = JSON.parse(await runtime.loadProtocol(VALID_SPEC_YAML));
    expect(result.loaded).toBe(true);

    // Protocol is now available
    const spec = registry.getProtocol('default');
    expect(spec).toBeDefined();

    await runtime.disconnect();
  });

  it('multi-agent negotiation with claim-based election', async () => {
    // Two agents connect
    const runtime1 = new DirectRuntime({
      stores, bus, namespace: 'default',
      agentId: 'agent-1', role: 'worker', maxIterations: 10, registry,
    });
    const runtime2 = new DirectRuntime({
      stores, bus, namespace: 'default',
      agentId: 'agent-2', role: 'worker', maxIterations: 10, registry,
    });

    await runtime1.connect();
    await runtime2.connect();

    // Both see 2 peers
    const assignments = await stores.roles.getAssignments();
    expect(assignments).toHaveLength(2);

    // Agent 1 wins the spec_author claim
    const claim1 = JSON.parse(await runtime1.claimResource('spec_author', 'I want to write the spec'));
    expect(claim1.status).toBe('approved');

    // Agent 2 tries — rejected
    const claim2 = JSON.parse(await runtime2.claimResource('spec_author', 'I also want to'));
    expect(claim2.status).toBe('rejected');

    // Agent 1 (author) sets state and proposes spec
    await runtime1.setState('spec_status', 'proposing');
    await runtime1.setState('spec_draft', VALID_SPEC_YAML);
    await runtime1.setState('spec_draft_version', '1');
    await runtime1.publishEvent('spec.proposed', { version: 1, summary: 'Initial draft' });

    // Agent 2 (reviewer) reads state
    const stateStr = await runtime2.getState();
    const state = JSON.parse(stateStr);
    expect(state.spec_status).toBe('proposing');
    expect(state.spec_draft).toBeDefined();

    // Agent 2 votes yes
    await runtime2.publishEvent('spec.vote', { vote: 'yes', from: 'agent-2' });

    // Agent 1 sees the vote and loads the protocol
    const loadResult = JSON.parse(await runtime1.loadProtocol(VALID_SPEC_YAML));
    expect(loadResult.loaded).toBe(true);

    // Agent 1 publishes activation
    await runtime1.setState('spec_status', 'activated');
    await runtime1.publishEvent('spec.activated', { name: 'emergent-collab' });

    // Both agents can now see the protocol
    const spec = registry.getProtocol('default');
    expect(spec).toBeDefined();
    expect(spec!.name).toBe('emergent-collab');

    await runtime1.disconnect();
    await runtime2.disconnect();
  });

  it('late joiner sees activated protocol and skips negotiation', async () => {
    // First agent loads protocol
    const runtime1 = new DirectRuntime({
      stores, bus, namespace: 'default',
      agentId: 'agent-1', role: 'leader', maxIterations: 10, registry,
    });
    await runtime1.connect();
    await runtime1.loadProtocol(VALID_SPEC_YAML);
    await runtime1.setState('spec_status', 'activated');

    // Late joiner connects
    const runtime2 = new DirectRuntime({
      stores, bus, namespace: 'default',
      agentId: 'agent-2', role: 'worker', maxIterations: 10, registry,
    });
    await runtime2.connect();

    // Late joiner checks state — sees activation
    const stateStr = await runtime2.getState();
    const state = JSON.parse(stateStr);
    expect(state.spec_status).toBe('activated');

    // Protocol is already loaded in registry
    const spec = registry.getProtocol('default');
    expect(spec).toBeDefined();

    await runtime1.disconnect();
    await runtime2.disconnect();
  });
});

// ─── Bootstrap prompt generation ────────────────────────────────────

describe('bootstrap prompt integration', () => {
  const mockTools = [
    {
      type: 'function' as const,
      function: {
        name: 'waggle',
        description: 'Batch coordination + env tool',
        parameters: { type: 'object' as const, properties: {}, required: [] as string[] },
      },
    },
  ];

  it('multi-agent prompt includes all negotiation primitives', () => {
    const prompt = generateSystemPrompt('agent-1', 'worker', mockTools, null, { peerCount: 3 });

    // Must mention all key state keys
    expect(prompt).toContain('spec_draft');
    expect(prompt).toContain('spec_status');
    expect(prompt).toContain('spec_draft_version');

    // Must mention all key events
    expect(prompt).toContain('spec.proposed');
    expect(prompt).toContain('spec.vote');
    expect(prompt).toContain('spec.activated');

    // Must mention claim
    expect(prompt).toContain('spec_author');

    // Must mention load_protocol
    expect(prompt).toContain('load_protocol');
  });

  it('single-agent prompt is simpler', () => {
    const prompt = generateSystemPrompt('solo-1', 'worker', mockTools, null, { peerCount: 1 });
    expect(prompt).toContain('load_protocol');
    expect(prompt).not.toContain('spec_author');
    expect(prompt).not.toContain('REVIEWER');
  });
});
