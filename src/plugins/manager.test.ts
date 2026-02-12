import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginManager } from './manager.js';
import type { IncubatorPlugin, PluginContext, ToolEntry } from '@honeybee-ai/hivemind-sdk/integrations';

// Mock the plugin loader
vi.mock('./loader.js', () => ({
  loadPlugin: vi.fn(),
}));

function makePlugin(name: string, tools: ToolEntry[] = []): IncubatorPlugin {
  return {
    name,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getToolEntries: vi.fn((_ctx: PluginContext) => tools),
    destroy: vi.fn(),
  };
}

function makeTool(name: string): ToolEntry {
  return {
    def: {
      type: 'function',
      function: {
        name,
        description: `Tool ${name}`,
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    schema: {},
    handler: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
  };
}

describe('PluginManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates with defaults', () => {
    const pm = new PluginManager();
    expect(pm.getLoadedNames()).toEqual([]);
    expect(pm.hasToolEntries()).toBe(false);
    expect(pm.getToolCount()).toBe(0);
  });

  it('loads a plugin', async () => {
    const { loadPlugin } = await import('./loader.js');
    const plugin = makePlugin('test-plugin', [makeTool('do_thing')]);
    (loadPlugin as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);

    const pm = new PluginManager({ verbose: true });
    await pm.load('test', 'test-plugin');

    expect(pm.getLoadedNames()).toEqual(['test']);
    expect(plugin.start).toHaveBeenCalled();
  });

  it('deduplicates by name', async () => {
    const { loadPlugin } = await import('./loader.js');
    const plugin = makePlugin('test');
    (loadPlugin as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);

    const pm = new PluginManager();
    await pm.load('test', 'test-pkg');
    await pm.load('test', 'test-pkg');

    expect(pm.getLoadedNames()).toEqual(['test']);
    expect(plugin.start).toHaveBeenCalledTimes(1);
  });

  it('buildToolEntries aggregates across plugins', async () => {
    const { loadPlugin } = await import('./loader.js');
    const plugin1 = makePlugin('p1', [makeTool('read_file'), makeTool('write_file')]);
    const plugin2 = makePlugin('p2', [makeTool('fetch')]);

    (loadPlugin as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(plugin1)
      .mockResolvedValueOnce(plugin2);

    const pm = new PluginManager();
    await pm.load('p1', 'pkg1');
    await pm.load('p2', 'pkg2');
    pm.buildToolEntries('/tmp', null, false);

    expect(pm.getToolCount()).toBe(3);
    expect(pm.hasToolEntries()).toBe(true);
    expect(pm.getToolNames().has('read_file')).toBe(true);
    expect(pm.getToolNames().has('write_file')).toBe(true);
    expect(pm.getToolNames().has('fetch')).toBe(true);
  });

  it('detects tool name collisions', async () => {
    const { loadPlugin } = await import('./loader.js');
    const plugin1 = makePlugin('p1', [makeTool('read_file')]);
    const plugin2 = makePlugin('p2', [makeTool('read_file')]); // Collision!

    (loadPlugin as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(plugin1)
      .mockResolvedValueOnce(plugin2);

    const pm = new PluginManager();
    await pm.load('p1', 'pkg1');
    await pm.load('p2', 'pkg2');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    pm.buildToolEntries('/tmp', null, false);

    // Should log collision warning and skip duplicate
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Tool name collision'));
    expect(pm.getToolCount()).toBe(1); // Only first wins
    errorSpy.mockRestore();
  });

  it('getHandlerMap returns handlers keyed by name', async () => {
    const { loadPlugin } = await import('./loader.js');
    const tools = [makeTool('my_tool')];
    const plugin = makePlugin('p', tools);
    (loadPlugin as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);

    const pm = new PluginManager();
    await pm.load('p', 'pkg');
    pm.buildToolEntries('/tmp', null, false);

    const map = pm.getHandlerMap();
    expect(map.has('my_tool')).toBe(true);
    expect(typeof map.get('my_tool')).toBe('function');
  });

  it('destroyAll stops and destroys all plugins', async () => {
    const { loadPlugin } = await import('./loader.js');
    const plugin = makePlugin('p', [makeTool('t')]);
    (loadPlugin as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);

    const pm = new PluginManager();
    await pm.load('p', 'pkg');
    pm.buildToolEntries('/tmp', null, false);

    await pm.destroyAll();

    expect(plugin.stop).toHaveBeenCalled();
    expect(plugin.destroy).toHaveBeenCalled();
    expect(pm.getLoadedNames()).toEqual([]);
    expect(pm.hasToolEntries()).toBe(false);
    expect(pm.getHandlerMap().size).toBe(0);
  });

  it('init with autoDiscover=false skips propolis', async () => {
    const { loadPlugin } = await import('./loader.js');
    (loadPlugin as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('not found'));

    const pm = new PluginManager();
    await pm.init({ autoDiscover: false });

    expect(loadPlugin).not.toHaveBeenCalled();
    expect(pm.getLoadedNames()).toEqual([]);
  });

  it('init autoDiscover fails gracefully', async () => {
    const { loadPlugin } = await import('./loader.js');
    (loadPlugin as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Module not found'));

    const pm = new PluginManager({ verbose: true });
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await pm.init({ autoDiscover: true });

    expect(pm.getLoadedNames()).toEqual([]);
    logSpy.mockRestore();
  });

  it('init loads brood plugins', async () => {
    const { loadPlugin } = await import('./loader.js');
    const plugin = makePlugin('docker-tools');
    (loadPlugin as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('no propolis')) // autoDiscover fails
      .mockResolvedValueOnce(plugin);

    const pm = new PluginManager();
    await pm.init({
      broodPlugins: [{ package: '@honeybee-ai/docker-tools', config: { socket: '/var/run/docker.sock' } }],
    });

    expect(pm.getLoadedNames()).toEqual(['docker-tools']);
  });

  it('init skips duplicate propolis from brood if already discovered', async () => {
    const { loadPlugin } = await import('./loader.js');
    const propolisPlugin = makePlugin('propolis', [makeTool('read_file')]);
    (loadPlugin as ReturnType<typeof vi.fn>).mockResolvedValue(propolisPlugin);

    const pm = new PluginManager();
    await pm.init({
      broodPlugins: [{ package: '@honeybee-ai/propolis' }],
    });

    // Should only be loaded once (autoDiscover), not twice
    expect(pm.getLoadedNames()).toEqual(['propolis']);
    expect(loadPlugin).toHaveBeenCalledTimes(1);
  });

  it('buildToolEntries passes context to plugins', async () => {
    const { loadPlugin } = await import('./loader.js');
    const plugin = makePlugin('p', [makeTool('t')]);
    (loadPlugin as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);

    const pm = new PluginManager();
    await pm.load('p', 'pkg');

    const mockGuard = { scan: vi.fn() };
    pm.buildToolEntries('/my/workdir', mockGuard, true);

    expect(plugin.getToolEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        workDir: '/my/workdir',
        guard: mockGuard,
        verbose: true,
      }),
    );
  });

  it('init loads legacy integrations from config', async () => {
    const { loadPlugin } = await import('./loader.js');
    const plugin = makePlugin('webhook');
    (loadPlugin as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('no propolis'))
      .mockResolvedValueOnce(plugin);

    const pm = new PluginManager();
    await pm.init({
      integrations: {
        webhook: { package: '@honeybee-ai/webhook-integration', enabled: true, config: { url: 'https://example.com' } },
        disabled: { package: '@honeybee-ai/other', enabled: false, config: {} },
      },
    });

    expect(pm.getLoadedNames()).toEqual(['webhook']);
  });

  it('init loads CLI-specified integrations', async () => {
    const { loadPlugin } = await import('./loader.js');
    const plugin = makePlugin('myint');
    (loadPlugin as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('no propolis'))
      .mockResolvedValueOnce(plugin);

    const pm = new PluginManager();
    await pm.init({
      integrations: {
        myint: { package: 'my-integration', enabled: true, config: { key: 'val' } },
      },
      cliIntegrations: ['myint'],
    });

    expect(pm.getLoadedNames()).toEqual(['myint']);
  });

  it('getToolEntries returns all entries', async () => {
    const { loadPlugin } = await import('./loader.js');
    const t1 = makeTool('a');
    const t2 = makeTool('b');
    const plugin = makePlugin('p', [t1, t2]);
    (loadPlugin as ReturnType<typeof vi.fn>).mockResolvedValue(plugin);

    const pm = new PluginManager();
    await pm.load('p', 'pkg');
    pm.buildToolEntries('/tmp', null, false);

    const entries = pm.getToolEntries();
    expect(entries.length).toBe(2);
    expect(entries[0].def.function.name).toBe('a');
    expect(entries[1].def.function.name).toBe('b');
  });
});
