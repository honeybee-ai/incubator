import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntegrationManager } from './manager.js';
import type { IntegrationModule, IntegrationEvent } from '@honeybee-ai/integration-sdk';
import type { NotificationBus } from '../bus.js';
import type { IEventStore } from '../stores/interfaces.js';

// Mock loader
vi.mock('./loader.js', () => ({
  loadIntegrationPackage: vi.fn(),
}));

import { loadIntegrationPackage } from './loader.js';
const mockLoad = vi.mocked(loadIntegrationPackage);

function createMockModule(name = 'test-integration'): IntegrationModule {
  return {
    name,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onEvent: vi.fn(async () => {}),
    getTools: vi.fn(() => [
      { name: `${name}-tool`, description: 'A test tool', inputSchema: { type: 'object' as const, properties: {} } },
    ]),
  };
}

function createMockBus(): NotificationBus & { _trigger?: (event: any) => void } {
  let handler: ((event: any) => void) | undefined;
  return {
    publish: vi.fn(async () => {}),
    subscribe: vi.fn((_ns: string, cb: (event: any) => void) => {
      handler = cb;
      return () => { handler = undefined; };
    }),
    close: vi.fn(async () => {}),
    get _trigger() { return handler; },
  };
}

function createMockEventStore(): IEventStore {
  return {
    publish: vi.fn(async () => ({ id: 'evt-1', type: 'test', data: {}, published_by: 'test', timestamp: Date.now() })),
    list: vi.fn(async () => []),
    clear: vi.fn(),
  };
}

describe('IntegrationManager', () => {
  let manager: IntegrationManager;
  let bus: ReturnType<typeof createMockBus>;
  let eventStore: ReturnType<typeof createMockEventStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    bus = createMockBus();
    eventStore = createMockEventStore();
    manager = new IntegrationManager({
      namespace: 'default',
      bus,
      eventStore,
      verbose: false,
    });
  });

  it('loads an integration module', async () => {
    const mod = createMockModule();
    mockLoad.mockResolvedValueOnce(mod);

    await manager.load('webhook', '@honeybee-ai/integration-webhook', { WEBHOOK_URL: 'https://example.com' });

    expect(mockLoad).toHaveBeenCalledWith('@honeybee-ai/integration-webhook');
    expect(mod.start).toHaveBeenCalledTimes(1);
    expect(manager.getLoadedNames()).toEqual(['webhook']);
  });

  it('passes config and namespace in context', async () => {
    const mod = createMockModule();
    mockLoad.mockResolvedValueOnce(mod);

    await manager.load('test', 'test-pkg', { MY_KEY: 'my-value' });

    const ctx = (mod.start as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(ctx.namespace).toBe('default');
    expect(ctx.config.MY_KEY).toBe('my-value');
    expect(typeof ctx.logger.info).toBe('function');
    expect(typeof ctx.publishEvent).toBe('function');
  });

  it('subscribes onEvent to bus', async () => {
    const mod = createMockModule();
    mockLoad.mockResolvedValueOnce(mod);

    await manager.load('test', 'test-pkg');

    expect(bus.subscribe).toHaveBeenCalledWith('default', expect.any(Function));
  });

  it('routes bus events to integration onEvent', async () => {
    const mod = createMockModule();
    mockLoad.mockResolvedValueOnce(mod);

    await manager.load('test', 'test-pkg');

    // Trigger a bus event
    bus._trigger?.({
      type: 'state.updated',
      data: { key: 'phase' },
      publishedBy: 'agent_1',
    });

    // Give the async handler a tick
    await new Promise(r => setTimeout(r, 10));

    expect(mod.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'state.updated',
        data: { key: 'phase' },
        agentId: 'agent_1',
        namespace: 'default',
      }),
    );
  });

  it('aggregates tools from loaded integrations', async () => {
    const mod1 = createMockModule('int-a');
    const mod2 = createMockModule('int-b');
    mockLoad.mockResolvedValueOnce(mod1);
    mockLoad.mockResolvedValueOnce(mod2);

    await manager.load('a', 'pkg-a');
    await manager.load('b', 'pkg-b');

    const tools = manager.getTools();
    expect(tools.length).toBe(2);
    expect(tools.map(t => t.name)).toEqual(['int-a-tool', 'int-b-tool']);
  });

  it('stopAll calls stop on all integrations', async () => {
    const mod1 = createMockModule('int-a');
    const mod2 = createMockModule('int-b');
    mockLoad.mockResolvedValueOnce(mod1);
    mockLoad.mockResolvedValueOnce(mod2);

    await manager.load('a', 'pkg-a');
    await manager.load('b', 'pkg-b');

    await manager.stopAll();

    expect(mod1.stop).toHaveBeenCalledTimes(1);
    expect(mod2.stop).toHaveBeenCalledTimes(1);
    expect(manager.getLoadedNames()).toEqual([]);
  });

  it('loadFromConfig loads enabled integrations', async () => {
    const mod = createMockModule();
    mockLoad.mockResolvedValue(mod);

    await manager.loadFromConfig({
      webhook: { package: 'webhook-pkg', enabled: true, config: {} },
      slack: { package: 'slack-pkg', enabled: false, config: {} },
    });

    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockLoad).toHaveBeenCalledWith('webhook-pkg');
    expect(manager.getLoadedNames()).toEqual(['webhook']);
  });

  it('loadFromConfig continues on error', async () => {
    mockLoad.mockRejectedValueOnce(new Error('bad package'));
    const mod = createMockModule();
    mockLoad.mockResolvedValueOnce(mod);

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await manager.loadFromConfig({
      bad: { package: 'bad-pkg', enabled: true, config: {} },
      good: { package: 'good-pkg', enabled: true, config: {} },
    });

    expect(manager.getLoadedNames()).toEqual(['good']);
    spy.mockRestore();
  });

  it('publishEvent routes through eventStore', async () => {
    const mod = createMockModule();
    mockLoad.mockResolvedValueOnce(mod);

    await manager.load('test', 'test-pkg');

    const ctx = (mod.start as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await ctx.publishEvent('custom.event', { key: 'val' });

    expect(eventStore.publish).toHaveBeenCalledWith('custom.event', { key: 'val' }, 'integration:test-integration');
  });

  it('handles integration without onEvent', async () => {
    const mod: IntegrationModule = {
      name: 'no-events',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    mockLoad.mockResolvedValueOnce(mod);

    await manager.load('test', 'test-pkg');

    // Should not subscribe to bus
    expect(bus.subscribe).not.toHaveBeenCalled();
  });

  it('handles integration without getTools', async () => {
    const mod: IntegrationModule = {
      name: 'no-tools',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    mockLoad.mockResolvedValueOnce(mod);

    await manager.load('test', 'test-pkg');

    expect(manager.getTools()).toEqual([]);
  });
});
