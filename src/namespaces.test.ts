import { describe, it, expect } from 'vitest';
import { NamespaceRegistry } from './namespaces.js';
import { LocalBus } from './bus.js';
import type { ProtocolSpec } from '@agentcoordinationprotocol/spec';

describe('NamespaceRegistry', () => {
  it('creates stores on first access', () => {
    const registry = new NamespaceRegistry();
    const stores = registry.get('team-a');
    expect(stores).toBeDefined();
    expect(stores.state).toBeDefined();
    expect(stores.claims).toBeDefined();
    expect(stores.events).toBeDefined();
    expect(stores.discoveries).toBeDefined();
  });

  it('returns same stores on subsequent access', () => {
    const registry = new NamespaceRegistry();
    const first = registry.get('team-a');
    const second = registry.get('team-a');
    expect(first).toBe(second);
  });

  it('isolates namespaces from each other', async () => {
    const registry = new NamespaceRegistry();
    const a = registry.get('ns-a');
    const b = registry.get('ns-b');

    await a.state.set('key', 'a-value', 'agent_1');
    expect((await a.state.get('key'))?.value).toBe('a-value');
    expect(await b.state.get('key')).toBeNull();
  });

  it('uses default namespace when no namespace specified', async () => {
    const registry = new NamespaceRegistry();
    const stores = registry.get('default');
    await stores.state.set('key', 'value', 'agent_1');
    expect((await registry.get('default').state.get('key'))?.value).toBe('value');
  });

  it('lists all active namespaces', () => {
    const registry = new NamespaceRegistry();
    registry.get('alpha');
    registry.get('beta');
    registry.get('gamma');
    expect(registry.list().sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('deletes a namespace and its data', async () => {
    const registry = new NamespaceRegistry();
    const stores = registry.get('temp');
    await stores.state.set('key', 'value', 'agent_1');

    expect(registry.delete('temp')).toBe(true);
    expect(registry.list()).not.toContain('temp');

    // Re-accessing creates fresh stores
    const fresh = registry.get('temp');
    expect(await fresh.state.get('key')).toBeNull();
  });

  it('delete returns false for non-existent namespace', () => {
    const registry = new NamespaceRegistry();
    expect(registry.delete('nope')).toBe(false);
  });

  it('rejects _ns as namespace name', () => {
    const registry = new NamespaceRegistry();
    expect(() => registry.get('_ns')).toThrow("'_ns' is a reserved name");
  });

  it('has() reports namespace existence', () => {
    const registry = new NamespaceRegistry();
    expect(registry.has('team-a')).toBe(false);
    registry.get('team-a');
    expect(registry.has('team-a')).toBe(true);
  });
});

// ─── Auto phase transitions ─────────────────────────────────────────

describe('NamespaceRegistry — auto phase transitions', () => {
  function makeSpec(phases: Record<string, { description: string; exit_condition?: { event: string }; terminal?: boolean }>): ProtocolSpec {
    return {
      acp: '1.0',
      name: 'test',
      title: 'Test',
      roles: { worker: { description: 'works' } },
      phases,
    } as ProtocolSpec;
  }

  it('advances phase when exit_condition event fires', async () => {
    const bus = new LocalBus();
    const registry = new NamespaceRegistry();
    registry.setBus(bus);

    const spec = makeSpec({
      research: { description: 'research', exit_condition: { event: 'research.complete' } },
      planning: { description: 'planning', exit_condition: { event: 'plan.complete' } },
      done: { description: 'done', terminal: true },
    });
    registry.setProtocol('default', spec);

    const stores = registry.get('default');
    // Set initial phase
    await stores.state.set('phase', 'research', '_system');

    // Publish the exit event
    await stores.events.publish('research.complete', { summary: 'done' }, 'researcher_1');

    // Phase should have auto-advanced
    const phase = await stores.state.get('phase');
    expect(phase?.value).toBe('planning');
  });

  it('advances through multiple phases', async () => {
    const bus = new LocalBus();
    const registry = new NamespaceRegistry();
    registry.setBus(bus);

    const spec = makeSpec({
      phase1: { description: 'p1', exit_condition: { event: 'p1.done' } },
      phase2: { description: 'p2', exit_condition: { event: 'p2.done' } },
      phase3: { description: 'p3', terminal: true },
    });
    registry.setProtocol('default', spec);

    const stores = registry.get('default');
    await stores.state.set('phase', 'phase1', '_system');

    // Trigger first transition
    await stores.events.publish('p1.done', {}, 'agent_1');
    expect((await stores.state.get('phase'))?.value).toBe('phase2');

    // Trigger second transition
    await stores.events.publish('p2.done', {}, 'agent_2');
    expect((await stores.state.get('phase'))?.value).toBe('phase3');
  });

  it('does not advance on unrelated events', async () => {
    const bus = new LocalBus();
    const registry = new NamespaceRegistry();
    registry.setBus(bus);

    const spec = makeSpec({
      research: { description: 'r', exit_condition: { event: 'research.complete' } },
      done: { description: 'd', terminal: true },
    });
    registry.setProtocol('default', spec);

    const stores = registry.get('default');
    await stores.state.set('phase', 'research', '_system');

    // Publish a non-matching event
    await stores.events.publish('some.other.event', {}, 'agent_1');

    const phase = await stores.state.get('phase');
    expect(phase?.value).toBe('research');
  });

  it('does not advance past terminal phase', async () => {
    const bus = new LocalBus();
    const registry = new NamespaceRegistry();
    registry.setBus(bus);

    const spec = makeSpec({
      only: { description: 'only phase', exit_condition: { event: 'done' }, terminal: true },
    });
    registry.setProtocol('default', spec);

    const stores = registry.get('default');
    await stores.state.set('phase', 'only', '_system');

    // Publish exit event — no next phase
    await stores.events.publish('done', {}, 'agent_1');

    const phase = await stores.state.get('phase');
    expect(phase?.value).toBe('only');
  });

  it('publishes phase.changed event on transition', async () => {
    const bus = new LocalBus();
    const registry = new NamespaceRegistry();
    registry.setBus(bus);

    const spec = makeSpec({
      a: { description: 'a', exit_condition: { event: 'a.done' } },
      b: { description: 'b', terminal: true },
    });
    registry.setProtocol('default', spec);

    const stores = registry.get('default');
    await stores.state.set('phase', 'a', '_system');

    const events: Array<{ type: string; data: unknown }> = [];
    bus.subscribe('default', (event) => {
      events.push({ type: event.type, data: event.data });
    });

    await stores.events.publish('a.done', {}, 'agent_1');

    const phaseChanged = events.find(e => e.type === 'phase.changed');
    expect(phaseChanged).toBeDefined();
    expect(phaseChanged!.data).toEqual({ from: 'a', to: 'b', trigger: 'a.done' });
  });

  it('uses first phase as default when phase key not set', async () => {
    const bus = new LocalBus();
    const registry = new NamespaceRegistry();
    registry.setBus(bus);

    const spec = makeSpec({
      first: { description: 'first', exit_condition: { event: 'first.done' } },
      second: { description: 'second', terminal: true },
    });
    registry.setProtocol('default', spec);

    const stores = registry.get('default');
    // Don't set phase — should default to 'first'

    await stores.events.publish('first.done', {}, 'agent_1');

    const phase = await stores.state.get('phase');
    expect(phase?.value).toBe('second');
  });

  it('works correctly with no protocol set', async () => {
    const bus = new LocalBus();
    const registry = new NamespaceRegistry();
    registry.setBus(bus);

    const stores = registry.get('default');
    // No protocol set — should not throw
    await stores.events.publish('anything', {}, 'agent_1');

    const phase = await stores.state.get('phase');
    expect(phase).toBeNull();
  });
});
