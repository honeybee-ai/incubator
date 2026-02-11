import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirectRuntime, type DirectRuntimeConfig } from './direct-runtime.js';
import { LocalBus } from '../../bus.js';
import { NamespaceRegistry } from '../../namespaces.js';
import type { Stores } from '../../stores/interfaces.js';
import type { NotificationBus } from '../../bus.js';
import type { DanceModule, DanceToolDef } from '../../dances.js';
import type { ProtocolResponse } from './runtime.js';

/** Create stores with bus wired up (so events.publish triggers bus notifications). */
function createWiredStores(): { stores: Stores; bus: LocalBus } {
  const bus = new LocalBus();
  const registry = new NamespaceRegistry();
  registry.setBus(bus);
  return { stores: registry.get('default'), bus };
}

function makeConfig(overrides?: Partial<DirectRuntimeConfig>): DirectRuntimeConfig {
  const { stores, bus } = createWiredStores();
  return {
    stores,
    bus,
    namespace: 'default',
    agentId: 'agent_abc',
    role: 'writer',
    maxIterations: 10,
    verbose: false,
    ...overrides,
  };
}

describe('DirectRuntime', () => {
  let stores: Stores;
  let bus: LocalBus;

  beforeEach(() => {
    const wired = createWiredStores();
    stores = wired.stores;
    bus = wired.bus;
  });

  it('connect() registers role in store', async () => {
    const rt = new DirectRuntime(makeConfig({ stores, bus }));
    await rt.connect();

    const assignment = await stores.roles.getByAgent('agent_abc');
    expect(assignment).not.toBeNull();
    expect(assignment!.role).toBe('writer');

    await rt.disconnect();
  });

  it('connect() starts a run in the run store', async () => {
    const rt = new DirectRuntime(makeConfig({ stores, bus }));
    await rt.connect();

    const run = await stores.runs.get('agent_abc');
    expect(run).not.toBeNull();
    expect(run!.status).toBe('running');

    await rt.disconnect();
  });

  it('publishEvent() writes to event store and notifies bus', async () => {
    const rt = new DirectRuntime(makeConfig({ stores, bus }));
    await rt.connect();

    const busEvents: unknown[] = [];
    bus.subscribe('default', (e) => busEvents.push(e));

    const result = await rt.publishEvent('move.made', { position: 5 });
    const parsed = JSON.parse(result);
    expect(parsed.published).toBe(true);

    const { events } = await stores.events.getEvents();
    // At least the move.made event
    const moveEvent = events.find(e => e.type === 'move.made');
    expect(moveEvent).toBeDefined();

    await rt.disconnect();
  });

  it('setState() / getState() round-trip through store', async () => {
    const rt = new DirectRuntime(makeConfig({ stores, bus }));
    await rt.connect();

    await rt.setState('board', JSON.stringify([1, 2, 3]));
    const state = await rt.getState();
    const parsed = JSON.parse(state);
    expect(parsed.board).toBeDefined();

    await rt.disconnect();
  });

  it('claimResource() / releaseResource() lifecycle', async () => {
    const rt = new DirectRuntime(makeConfig({ stores, bus }));
    await rt.connect();

    const claimResult = await rt.claimResource('topic:quantum', 'researching');
    expect(JSON.parse(claimResult).status).toBe('approved');

    // Another runtime trying to claim same resource gets rejected
    const rt2 = new DirectRuntime(makeConfig({ stores, bus, agentId: 'agent_xyz', role: 'researcher' }));
    await rt2.connect();
    const rejectResult = await rt2.claimResource('topic:quantum');
    expect(JSON.parse(rejectResult).status).toBe('rejected');

    // Release and re-claim
    const releaseResult = await rt.releaseResource('topic:quantum');
    expect(JSON.parse(releaseResult).released).toBe(true);

    const reclaimResult = await rt2.claimResource('topic:quantum');
    expect(JSON.parse(reclaimResult).status).toBe('approved');

    await rt.disconnect();
    await rt2.disconnect();
  });

  it('waitForWake() resolves on bus event', async () => {
    const rt = new DirectRuntime(makeConfig({ stores, bus }));
    await rt.connect();

    // Publish event after a short delay (no await in setTimeout)
    setTimeout(() => {
      stores.events.publish('turn.complete', { turn: 1 }, 'other_agent');
    }, 50);

    const events = await rt.waitForWake({ timeout: 2000 });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toContain('[turn.complete]');

    await rt.disconnect();
  });

  it('waitForWake() respects type filter', async () => {
    const rt = new DirectRuntime(makeConfig({ stores, bus }));
    await rt.connect();

    // Publish non-matching event first, then matching (use non-async setTimeout)
    setTimeout(() => {
      stores.events.publish('irrelevant.event', {}, 'other_agent');
    }, 30);
    setTimeout(() => {
      stores.events.publish('turn.complete', { turn: 1 }, 'other_agent');
    }, 60);

    const events = await rt.waitForWake({ types: ['turn.complete'], timeout: 2000 });
    expect(events.length).toBe(1);
    expect(events[0]).toContain('[turn.complete]');

    await rt.disconnect();
  });

  it('waitForWake() times out when no events', async () => {
    const rt = new DirectRuntime(makeConfig({ stores, bus }));
    await rt.connect();

    const events = await rt.waitForWake({ timeout: 100 });
    expect(events).toEqual([]);

    await rt.disconnect();
  });

  it('beforeIteration() drains buffered events', async () => {
    const rt = new DirectRuntime(makeConfig({ stores, bus }));
    await rt.connect();

    // Publish events — they get buffered via bus subscription
    await stores.events.publish('move.made', { pos: 1 }, 'other_agent');
    await stores.events.publish('move.made', { pos: 2 }, 'other_agent');

    // Small delay for bus delivery
    await new Promise(r => setTimeout(r, 10));

    const messages = await rt.beforeIteration();
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.some(m => m.includes('[move.made]'))).toBe(true);

    // Second call returns empty (buffer drained)
    const messages2 = await rt.beforeIteration();
    expect(messages2.length).toBe(0);

    await rt.disconnect();
  });

  it('checkControl() reads from control store', async () => {
    const rt = new DirectRuntime(makeConfig({ stores, bus }));
    await rt.connect();

    // Default: not halted, not paused
    const status = await rt.checkControl();
    expect(status.halted).toBe(false);
    expect(status.paused).toBe(false);

    // Halt the protocol
    await stores.control.halt('game over', 'system');
    const halted = await rt.checkControl();
    expect(halted.halted).toBe(true);

    await rt.disconnect();
  });

  it('onComplete() releases claims and updates run', async () => {
    const rt = new DirectRuntime(makeConfig({ stores, bus }));
    await rt.connect();

    // Claim a resource
    await rt.claimResource('file:main.ts');

    // Complete
    const usage = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };
    await rt.onComplete('Task done', usage);

    // Run should be completed
    const run = await stores.runs.get('agent_abc');
    expect(run!.status).toBe('completed');
    expect(run!.summary).toBe('Task done');

    // Claim should be released
    const claim = await stores.claims.check('file:main.ts');
    expect(claim === null || claim.status === 'released').toBe(true);

    await rt.disconnect();
  });

  it('onFileWrite() auto-claims file', async () => {
    const rt = new DirectRuntime(makeConfig({ stores, bus }));
    await rt.connect();

    const result = await rt.onFileWrite('/tmp/file.ts');
    expect(result).toBeNull(); // no conflict

    const claim = await stores.claims.check('/tmp/file.ts');
    expect(claim).not.toBeNull();
    expect(claim!.owner).toBe('agent_abc');

    await rt.disconnect();
  });

  it('onFileWrite() returns error on conflict', async () => {
    const rt = new DirectRuntime(makeConfig({ stores, bus }));
    await rt.connect();

    // Pre-claim by another agent
    await stores.claims.claim('/tmp/file.ts', '/tmp/file.ts', 'other_agent');

    const result = await rt.onFileWrite('/tmp/file.ts');
    expect(result).not.toBeNull();
    expect(result).toContain('claimed by');

    await rt.disconnect();
  });

  it('fetchProtocol() returns pre-loaded protocol data', async () => {
    const protocolData: ProtocolResponse = {
      protocol: { name: 'test', title: 'Test Protocol' },
      role: { name: 'writer', description: 'writes stuff' },
      current_phase: 'main',
      instructions: 'do the thing',
      phases: { main: { description: 'main phase' } },
    };

    const rt = new DirectRuntime(makeConfig({ stores, bus, protocolData }));
    const result = await rt.fetchProtocol();
    expect(result).toEqual(protocolData);
  });

  it('fetchProtocol() returns null when no protocol data', async () => {
    const rt = new DirectRuntime(makeConfig({ stores, bus }));
    const result = await rt.fetchProtocol();
    expect(result).toBeNull();
  });

  it('getDanceTools() returns tool defs from dance module', async () => {
    const testTool: DanceToolDef = {
      description: 'test tool',
      params: { input: { type: 'string', description: 'test input' } },
      handler: async () => ({ result: 'ok' }),
    };
    const danceModule: DanceModule = {
      tools: new Map([['test_tool', testTool]]),
    };

    const rt = new DirectRuntime(makeConfig({ stores, bus, danceModule }));
    const tools = rt.getDanceTools();
    expect(tools).not.toBeNull();
    expect(tools!.length).toBe(1);
    expect(tools![0].function.name).toBe('test_tool');
  });

  it('getDanceTools() returns null without dance module', async () => {
    const rt = new DirectRuntime(makeConfig({ stores, bus }));
    const tools = rt.getDanceTools();
    expect(tools).toBeNull();
  });

  it('callDanceTool() executes handler directly', async () => {
    const handler = vi.fn(async (ctx) => ({ result: `Hello ${ctx.args.name}` }));
    const danceModule: DanceModule = {
      tools: new Map([['greet', {
        description: 'greet someone',
        params: { name: { type: 'string' } },
        handler,
      }]]),
    };

    const rt = new DirectRuntime(makeConfig({ stores, bus, danceModule }));
    await rt.connect();

    const result = await rt.callDanceTool('greet', { name: 'world' });
    expect(handler).toHaveBeenCalled();
    expect(result).toEqual({ result: 'Hello world' });

    await rt.disconnect();
  });

  it('getLastInject() returns inject from dance module and consumes', async () => {
    const danceModule: DanceModule = {
      inject: ({ state, agent }) => `Board: ${state.board ?? 'empty'}, Role: ${agent.role}`,
      tools: new Map(),
    };

    const rt = new DirectRuntime(makeConfig({ stores, bus, danceModule }));
    await rt.connect();

    // Set state for inject
    await stores.state.set('board', 'X__O_____', 'system');

    // waitForWake computes inject cache
    setTimeout(() => {
      stores.events.publish('turn.done', {}, 'other');
    }, 50);
    await rt.waitForWake({ timeout: 2000 });

    const inject = rt.getLastInject();
    expect(inject).toContain('Board:');
    expect(inject).toContain('Role: writer');

    // Consumed on read
    const inject2 = rt.getLastInject();
    expect(inject2).toBeNull();

    await rt.disconnect();
  });

  it('waitForWake() replays events published before agent connected', async () => {
    // Simulate: Player X publishes a move BEFORE Player O connects
    await stores.events.publish('move', { cell: 0, mark: 'X' }, 'player_x_abc');

    // Player O connects AFTER the event
    const rt = new DirectRuntime(makeConfig({ stores, bus, agentId: 'player_o_xyz', role: 'player_o' }));
    await rt.connect();

    // waitForWake should find the missed event via store replay
    const events = await rt.waitForWake({ types: ['move'], timeout: 500 });
    expect(events.length).toBe(1);
    expect(events[0]).toContain('[move]');
    expect(events[0]).toContain('player_x_abc');

    await rt.disconnect();
  });

  it('waitForWake() does not duplicate events from bus and store replay', async () => {
    const rt = new DirectRuntime(makeConfig({ stores, bus }));
    await rt.connect();

    // Publish event while connected (arrives via bus AND will be in store)
    await stores.events.publish('move', { cell: 0 }, 'other_agent');
    await new Promise(r => setTimeout(r, 10));

    // waitForWake replays from store but shouldn't duplicate bus-delivered events
    const events = await rt.waitForWake({ types: ['move'], timeout: 500 });
    expect(events.length).toBe(1);

    await rt.disconnect();
  });

  it('disconnect() releases all claims and unsubscribes', async () => {
    const rt = new DirectRuntime(makeConfig({ stores, bus }));
    await rt.connect();

    await rt.claimResource('file:a.ts');
    await rt.claimResource('file:b.ts');

    await rt.disconnect();

    // Claims should be released
    const claimA = await stores.claims.check('file:a.ts');
    const claimB = await stores.claims.check('file:b.ts');
    expect(claimA === null || claimA.status === 'released').toBe(true);
    expect(claimB === null || claimB.status === 'released').toBe(true);
  });
});
