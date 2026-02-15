import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TriggerEngine, parseDuration, type TriggerEngineConfig } from './triggers.js';
import type { NotificationBus } from './bus.js';
import type { IncubatorEvent } from './types.js';
import type { Stores } from './stores/interfaces.js';
import type { DanceModule, DanceTriggerDef, DanceAcpHelper } from './dances.js';

// ─── Test Helpers ──────────────────────────────────────────────

function mockBus(): NotificationBus & { listeners: Map<string, Set<(event: IncubatorEvent) => void>> } {
  const listeners = new Map<string, Set<(event: IncubatorEvent) => void>>();
  return {
    listeners,
    publish(ns: string, event: IncubatorEvent) {
      const fns = listeners.get(ns);
      if (fns) for (const fn of fns) fn(event);
    },
    subscribe(ns: string, listener: (event: IncubatorEvent) => void) {
      let fns = listeners.get(ns);
      if (!fns) { fns = new Set(); listeners.set(ns, fns); }
      fns.add(listener);
      return () => { fns!.delete(listener); };
    },
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function mockEvent(type: string, publishedBy = 'agent_1', data: unknown = {}): IncubatorEvent {
  return { id: 1, type, data, publishedBy, publishedAt: new Date().toISOString() };
}

function mockStores(): Stores {
  return {
    state: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(true),
      query: vi.fn().mockResolvedValue([]),
      getAll: vi.fn().mockResolvedValue([]),
      load: vi.fn().mockResolvedValue(undefined),
    },
    events: {
      publish: vi.fn().mockImplementation(async (type, data, agentId) => ({
        id: 99, type, data, publishedBy: agentId, publishedAt: new Date().toISOString(),
      })),
      getEvents: vi.fn().mockResolvedValue({ events: [], cursor: 0 }),
      getCursor: vi.fn().mockResolvedValue(0),
      getAll: vi.fn().mockResolvedValue([]),
      load: vi.fn().mockResolvedValue(undefined),
    },
    claims: { claim: vi.fn(), release: vi.fn(), check: vi.fn(), list: vi.fn(), getAll: vi.fn(), load: vi.fn() } as any,
    discoveries: { publish: vi.fn(), search: vi.fn(), getAll: vi.fn(), load: vi.fn() } as any,
    messages: { send: vi.fn(), getFor: vi.fn(), getAll: vi.fn() } as any,
    help: { request: vi.fn(), claim: vi.fn(), resolve: vi.fn(), list: vi.fn() } as any,
    progress: { report: vi.fn(), get: vi.fn(), list: vi.fn() } as any,
    conflicts: { flag: vi.fn(), resolve: vi.fn(), list: vi.fn() } as any,
    roles: { assign: vi.fn(), getAssignments: vi.fn(), getByAgent: vi.fn(), remove: vi.fn() } as any,
    proposals: { propose: vi.fn(), endorse: vi.fn(), list: vi.fn(), get: vi.fn() } as any,
    reinforcements: { request: vi.fn(), approve: vi.fn(), deny: vi.fn(), list: vi.fn() } as any,
    control: { halt: vi.fn().mockResolvedValue({}), getStatus: vi.fn(), pause: vi.fn(), resume: vi.fn() } as any,
    runs: { start: vi.fn(), complete: vi.fn(), get: vi.fn(), list: vi.fn(), summary: vi.fn() } as any,
  };
}

function mockAcpHelper(): DanceAcpHelper {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    claim: vi.fn().mockResolvedValue('claim-1'),
    release: vi.fn().mockResolvedValue(undefined),
    setState: vi.fn().mockResolvedValue(undefined),
  };
}

function createEngine(
  config: Partial<TriggerEngineConfig>,
  stores?: Stores,
  bus?: ReturnType<typeof mockBus>,
  acp?: DanceAcpHelper,
) {
  const s = stores ?? mockStores();
  const b = bus ?? mockBus();
  const a = acp ?? mockAcpHelper();
  const fullConfig: TriggerEngineConfig = { namespace: 'default', ...config };
  return { engine: new TriggerEngine(fullConfig, s, b, a), stores: s, bus: b, acp: a };
}

// ─── parseDuration ─────────────────────────────────────────────

describe('parseDuration', () => {
  it('parses seconds', () => {
    expect(parseDuration('30s')).toBe(30_000);
  });

  it('parses minutes', () => {
    expect(parseDuration('15m')).toBe(900_000);
  });

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
  });

  it('parses compound duration', () => {
    expect(parseDuration('2h30m')).toBe(9_000_000);
  });

  it('parses h+m+s compound', () => {
    expect(parseDuration('1h30m15s')).toBe(5_415_000);
  });

  it('throws on invalid format', () => {
    expect(() => parseDuration('abc')).toThrow('Invalid duration');
    expect(() => parseDuration('')).toThrow('Invalid duration');
    expect(() => parseDuration('10')).toThrow('Invalid duration');
  });
});

// ─── Event Matching ────────────────────────────────────────────

describe('event matching', () => {
  it('fires on exact event type match', () => {
    const { engine, stores, bus } = createEngine({
      on: { 'plan.question': 'log' },
    });

    engine.start();
    bus.publish('default', mockEvent('plan.question'));

    expect(stores.control.halt).not.toHaveBeenCalled(); // log action, not halt
    engine.stop();
  });

  it('fires on glob event type match', () => {
    const { engine, stores, bus } = createEngine({
      on: { 'plan.*': { action: 'halt', config: { reason: 'glob match' } } },
    });

    engine.start();
    bus.publish('default', mockEvent('plan.complete'));

    expect(stores.control.halt).toHaveBeenCalledWith(
      'glob match',
      'trigger:halt',
    );
    engine.stop();
  });

  it('does not fire on non-matching events', () => {
    const { engine, stores, bus } = createEngine({
      on: { 'plan.question': { action: 'halt' } },
    });

    engine.start();
    bus.publish('default', mockEvent('validation.failed'));

    expect(stores.control.halt).not.toHaveBeenCalled();
    engine.stop();
  });

  it('exact match takes priority over glob', () => {
    const { engine, stores, bus } = createEngine({
      on: {
        'plan.question': { action: 'halt', config: { reason: 'exact' } },
        'plan.*': { action: 'halt', config: { reason: 'glob' } },
      },
    });

    engine.start();
    bus.publish('default', mockEvent('plan.question'));

    expect(stores.control.halt).toHaveBeenCalledWith('exact', 'trigger:halt');
    engine.stop();
  });
});

// ─── Loop Prevention ──────────────────────────────────────────

describe('loop prevention', () => {
  it('skips events published by triggers', () => {
    const { engine, stores, bus } = createEngine({
      on: { 'test.event': { action: 'halt' } },
    });

    engine.start();
    bus.publish('default', mockEvent('test.event', 'trigger:publish'));

    expect(stores.control.halt).not.toHaveBeenCalled();
    engine.stop();
  });

  it('skips events with any trigger: prefix', () => {
    const { engine, stores, bus } = createEngine({
      on: { 'test.event': { action: 'halt' } },
    });

    engine.start();
    bus.publish('default', mockEvent('test.event', 'trigger:schedule'));
    bus.publish('default', mockEvent('test.event', 'trigger:halt'));
    bus.publish('default', mockEvent('test.event', 'trigger:custom'));

    expect(stores.control.halt).not.toHaveBeenCalled();
    engine.stop();
  });

  it('processes events from non-trigger sources', () => {
    const { engine, stores, bus } = createEngine({
      on: { 'test.event': { action: 'halt' } },
    });

    engine.start();
    bus.publish('default', mockEvent('test.event', 'agent_1'));

    expect(stores.control.halt).toHaveBeenCalled();
    engine.stop();
  });
});

// ─── Built-in Actions ─────────────────────────────────────────

describe('built-in actions', () => {
  it('halt action calls control.halt', () => {
    const { engine, stores, bus } = createEngine({
      on: { 'emergency': { action: 'halt', config: { reason: 'test halt' } } },
    });

    engine.start();
    bus.publish('default', mockEvent('emergency'));

    expect(stores.control.halt).toHaveBeenCalledWith('test halt', 'trigger:halt');
    engine.stop();
  });

  it('halt action uses default reason when no config', () => {
    const { engine, stores, bus } = createEngine({
      on: { 'emergency': 'halt' },
    });

    engine.start();
    bus.publish('default', mockEvent('emergency'));

    expect(stores.control.halt).toHaveBeenCalledWith(
      'Trigger halt on emergency',
      'trigger:halt',
    );
    engine.stop();
  });

  it('publish action republishes with new type', () => {
    const { engine, stores, bus } = createEngine({
      on: { 'source.event': { action: 'publish', config: { type: 'derived.event' } } },
    });

    engine.start();
    bus.publish('default', mockEvent('source.event'));

    expect(stores.events.publish).toHaveBeenCalledWith(
      'derived.event',
      expect.objectContaining({ source: 'source.event' }),
      'trigger:publish',
    );
    engine.stop();
  });

  it('publish action logs error when no config.type', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { engine, bus } = createEngine({
      on: { 'test': { action: 'publish' } },
    });

    engine.start();
    bus.publish('default', mockEvent('test'));

    // Give async dispatch time to run
    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('publish action requires config.type'),
      );
    });

    consoleSpy.mockRestore();
    engine.stop();
  });

  it('log action does not throw', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { engine, bus } = createEngine({
      on: { 'test': 'log' },
    });

    engine.start();
    bus.publish('default', mockEvent('test'));

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('log: test'),
    );

    consoleSpy.mockRestore();
    engine.stop();
  });

  it('webhook action blocks private IPs (SSRF)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { engine, bus } = createEngine({
      on: { 'test': { action: 'webhook', config: { url: 'http://127.0.0.1:8080/hook' } } },
    });

    engine.start();
    bus.publish('default', mockEvent('test'));

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('webhook blocked: private/loopback URL'),
      );
    });

    consoleSpy.mockRestore();
    engine.stop();
  });

  it('webhook action blocks localhost', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { engine, bus } = createEngine({
      on: { 'test': { action: 'webhook', config: { url: 'http://localhost:3000/hook' } } },
    });

    engine.start();
    bus.publish('default', mockEvent('test'));

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('webhook blocked'),
      );
    });

    consoleSpy.mockRestore();
    engine.stop();
  });

  it('webhook action blocks 10.x private range', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { engine, bus } = createEngine({
      on: { 'test': { action: 'webhook', config: { url: 'http://10.0.0.1:8080/hook' } } },
    });

    engine.start();
    bus.publish('default', mockEvent('test'));

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('webhook blocked'),
      );
    });

    consoleSpy.mockRestore();
    engine.stop();
  });

  it('webhook action logs error when no url', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { engine, bus } = createEngine({
      on: { 'test': { action: 'webhook' } },
    });

    engine.start();
    bus.publish('default', mockEvent('test'));

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('webhook action requires config.url'),
      );
    });

    consoleSpy.mockRestore();
    engine.stop();
  });

  it('webhook action with fetch timeout', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Mock fetch to abort
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    const { engine, bus } = createEngine({
      on: { 'test': { action: 'webhook', config: { url: 'https://hooks.example.com/test' } } },
    });

    engine.start();
    bus.publish('default', mockEvent('test'));

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('timed out'),
      );
    });

    globalThis.fetch = originalFetch;
    consoleSpy.mockRestore();
    engine.stop();
  });

  it('unknown action logs error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { engine, bus } = createEngine({
      on: { 'test': 'nonexistent_action' },
    });

    engine.start();
    bus.publish('default', mockEvent('test'));

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown action "nonexistent_action"'),
      );
    });

    consoleSpy.mockRestore();
    engine.stop();
  });
});

// ─── Dance Triggers ────────────────────────────────────────────

describe('dance triggers', () => {
  it('dance trigger takes priority over built-in action', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const danceModule: DanceModule = {
      tools: new Map(),
      triggers: new Map([
        ['halt', { description: 'Custom halt', handler }],
      ]),
    };

    const { engine, stores, bus } = createEngine({
      on: { 'test': 'halt' },
    });
    engine.setDanceModule(danceModule);

    engine.start();
    bus.publish('default', mockEvent('test'));

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({ type: 'test' }),
          state: {},
          acp: expect.any(Object),
        }),
      );
    });

    // Built-in halt should NOT be called
    expect(stores.control.halt).not.toHaveBeenCalled();
    engine.stop();
  });

  it('dance trigger receives state from stores', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const danceModule: DanceModule = {
      tools: new Map(),
      triggers: new Map([
        ['log', { description: 'Log trigger', handler }],
      ]),
    };

    const stores = mockStores();
    (stores.state.query as ReturnType<typeof vi.fn>).mockResolvedValue([
      { key: 'phase', value: 'planning', setBy: 'a', setAt: '', updatedAt: '' },
      { key: 'count', value: 42, setBy: 'a', setAt: '', updatedAt: '' },
    ]);

    const { engine, bus } = createEngine({ on: { 'test': 'log' } }, stores);
    engine.setDanceModule(danceModule);

    engine.start();
    bus.publish('default', mockEvent('test'));

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          state: { phase: 'planning', count: '42' },
        }),
      );
    });

    engine.stop();
  });

  it('dance trigger errors are caught (fire-and-forget)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn().mockRejectedValue(new Error('trigger crash'));
    const danceModule: DanceModule = {
      tools: new Map(),
      triggers: new Map([
        ['boom', { description: 'Crasher', handler }],
      ]),
    };

    const { engine, bus } = createEngine({ on: { 'test': 'boom' } });
    engine.setDanceModule(danceModule);

    engine.start();
    bus.publish('default', mockEvent('test'));

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('trigger crash'),
      );
    });

    consoleSpy.mockRestore();
    engine.stop();
  });

  it('falls back to built-in when dance has no matching trigger', () => {
    const danceModule: DanceModule = {
      tools: new Map(),
      triggers: new Map([
        ['custom_action', { description: 'Custom', handler: vi.fn().mockResolvedValue(undefined) }],
      ]),
    };

    const { engine, stores, bus } = createEngine({
      on: { 'test': 'halt' },
    });
    engine.setDanceModule(danceModule);

    engine.start();
    bus.publish('default', mockEvent('test'));

    // Built-in halt should be called since dance has no "halt" trigger
    expect(stores.control.halt).toHaveBeenCalled();
    engine.stop();
  });
});

// ─── Schedule Triggers ─────────────────────────────────────────

describe('schedule triggers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires action at interval', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { engine } = createEngine({
      schedule: {
        heartbeat: { every: '30s', action: 'log' },
      },
    });

    engine.start();

    // Advance 30s
    await vi.advanceTimersByTimeAsync(30_000);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('log: schedule.heartbeat'),
    );

    consoleSpy.mockRestore();
    engine.stop();
  });

  it('fires multiple times at interval', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { engine } = createEngine({
      schedule: {
        tick: { every: '10s', action: 'log' },
      },
    });

    engine.start();

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    const logCalls = consoleSpy.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('log: schedule.tick'),
    );
    expect(logCalls.length).toBe(3);

    consoleSpy.mockRestore();
    engine.stop();
  });

  it('schedule publishes events with correct publishedBy', async () => {
    const { engine, stores } = createEngine({
      schedule: {
        heartbeat: {
          every: '15m',
          action: 'publish',
          config: { type: 'hive.heartbeat' },
        },
      },
    });

    engine.start();
    await vi.advanceTimersByTimeAsync(900_000);

    expect(stores.events.publish).toHaveBeenCalledWith(
      'hive.heartbeat',
      expect.objectContaining({ source: 'schedule.heartbeat' }),
      'trigger:publish',
    );

    engine.stop();
  });

  it('stop clears all schedule timers', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { engine } = createEngine({
      schedule: {
        tick: { every: '10s', action: 'log' },
      },
    });

    engine.start();
    engine.stop();

    await vi.advanceTimersByTimeAsync(30_000);

    const logCalls = consoleSpy.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('log: schedule.tick'),
    );
    expect(logCalls.length).toBe(0);

    consoleSpy.mockRestore();
  });

  it('schedule with halt action triggers halt', async () => {
    const { engine, stores } = createEngine({
      schedule: {
        timeout: { every: '1h', action: 'halt', config: { reason: 'timed out' } },
      },
    });

    engine.start();
    await vi.advanceTimersByTimeAsync(3_600_000);

    expect(stores.control.halt).toHaveBeenCalledWith('timed out', 'trigger:halt');
    engine.stop();
  });
});

// ─── Lifecycle ─────────────────────────────────────────────────

describe('lifecycle', () => {
  it('getTriggers returns configured triggers', () => {
    const { engine } = createEngine({
      on: { 'a': 'log', 'b': { action: 'halt' } },
    });

    const triggers = engine.getTriggers();
    expect(triggers.size).toBe(2);
    expect(triggers.get('a')).toEqual({ action: 'log' });
    expect(triggers.get('b')).toEqual({ action: 'halt' });
  });

  it('getSchedules returns configured schedules', () => {
    const { engine } = createEngine({
      schedule: {
        heartbeat: { every: '15m', action: 'publish', config: { type: 'hb' } },
      },
    });

    const schedules = engine.getSchedules();
    expect(schedules.size).toBe(1);
    expect(schedules.get('heartbeat')).toEqual({
      every: '15m',
      action: 'publish',
      config: { type: 'hb' },
    });
  });

  it('start is idempotent', () => {
    const bus = mockBus();
    const { engine } = createEngine({ on: { 'test': 'log' } }, undefined, bus);

    engine.start();
    engine.start(); // should not double-subscribe

    expect(bus.listeners.get('default')?.size).toBe(1);
    engine.stop();
  });

  it('stop is idempotent', () => {
    const { engine } = createEngine({ on: { 'test': 'log' } });

    engine.start();
    engine.stop();
    engine.stop(); // should not throw
  });

  it('does not subscribe to bus when no event triggers', () => {
    const bus = mockBus();
    const { engine } = createEngine({
      schedule: { tick: { every: '30s', action: 'log' } },
    }, undefined, bus);

    engine.start();
    expect(bus.listeners.get('default')?.size ?? 0).toBe(0);
    engine.stop();
  });

  it('publishes container.warmup on start when compute is set', () => {
    const { engine, stores } = createEngine({
      compute: 'shared',
      region: 'us-east',
    });

    engine.start();

    expect(stores.events.publish).toHaveBeenCalledWith(
      'container.warmup',
      { compute: 'shared', region: 'us-east' },
      'trigger:warmup',
    );
    engine.stop();
  });

  it('does not publish warmup for edge compute', () => {
    const { engine, stores } = createEngine({
      compute: 'edge',
    });

    engine.start();

    expect(stores.events.publish).not.toHaveBeenCalled();
    engine.stop();
  });
});

// ─── Telemetry ────────────────────────────────────────────────

describe('telemetry', () => {
  it('records trigger_fired events', () => {
    const telemetry = { record: vi.fn(), start: vi.fn(), stop: vi.fn() } as any;
    const { engine, bus } = createEngine({
      on: { 'test': 'log' },
    });
    engine.setTelemetry(telemetry);

    engine.start();
    bus.publish('default', mockEvent('test'));

    expect(telemetry.record).toHaveBeenCalledWith(
      'trigger_fired',
      expect.objectContaining({
        triggerEvent: 'test',
        action: 'log',
      }),
    );

    engine.stop();
  });
});

// ─── String action shorthand ───────────────────────────────────

describe('string action shorthand', () => {
  it('normalizes string actions to TriggerActionConfig', () => {
    const { engine } = createEngine({
      on: { 'test': 'log' },
    });

    const triggers = engine.getTriggers();
    expect(triggers.get('test')).toEqual({ action: 'log' });
  });
});
