/**
 * Unified plugin/integration loader.
 *
 * Handles both new IncubatorPlugin and legacy IntegrationModule patterns.
 * Detection order: createPlugin factory > default export factory > direct module.
 */

import type {
  IncubatorPlugin,
  PluginFactory,
  IntegrationModule,
  IntegrationFactory,
  ToolEntry,
  ToolResult,
  PluginContext,
  IntegrationEvent,
  ToolDefinition,
} from '@honeybee-ai/hivemind-sdk/integrations';

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Load a package and return an IncubatorPlugin.
 * If the package exports a legacy IntegrationModule, wraps it automatically.
 */
export async function loadPlugin(
  packageName: string,
  config?: Record<string, string>,
): Promise<IncubatorPlugin> {
  // Resolve file paths to file:// URLs (ESM import() resolves relative to calling module, not CWD)
  const importPath = packageName.startsWith('.') || packageName.startsWith('/')
    ? pathToFileURL(resolve(packageName)).href
    : packageName;
  const mod = await import(importPath);

  // 1. New plugin factory: named export createPlugin(config?)
  const pluginFactory: PluginFactory | undefined =
    mod.createPlugin ??
    mod.default?.createPlugin;

  if (typeof pluginFactory === 'function') {
    const plugin = pluginFactory(config);
    if (plugin && typeof plugin.start === 'function' && typeof plugin.stop === 'function' && plugin.name) {
      return plugin;
    }
  }

  // 2. Default export plugin factory
  const defaultFactory =
    mod.default?.default ??  // CJS interop
    mod.default;

  if (typeof defaultFactory === 'function') {
    const instance = defaultFactory(config);
    if (instance && typeof instance.start === 'function' && typeof instance.stop === 'function') {
      // Check if it's a full IncubatorPlugin (has getToolEntries)
      if (typeof instance.getToolEntries === 'function') {
        return instance;
      }
      // Legacy IntegrationModule — wrap it
      return wrapIntegration(instance);
    }
  }

  // 3. Direct module (already instantiated)
  if (mod.default && typeof mod.default.start === 'function') {
    if (typeof mod.default.getToolEntries === 'function') {
      return mod.default;
    }
    return wrapIntegration(mod.default);
  }

  // 4. TOOL_DEFS export (propolis legacy path — wrap into plugin)
  if (typeof mod.TOOL_DEFS === 'function') {
    return wrapToolDefs(packageName, mod);
  }

  throw new Error(
    `Package "${packageName}" does not export a valid PluginFactory, IntegrationModule, or TOOL_DEFS. ` +
    `Expected createPlugin(), default export factory, or TOOL_DEFS function.`
  );
}

/**
 * Wrap a legacy IntegrationModule into an IncubatorPlugin.
 * getTools() results get auto-converted to ToolEntry[] with wrapped handlers.
 */
function wrapIntegration(module: IntegrationModule): IncubatorPlugin {
  return {
    name: module.name,

    async start(ctx: PluginContext): Promise<void> {
      await module.start(ctx);
    },

    async stop(): Promise<void> {
      await module.stop();
    },

    onEvent: module.onEvent
      ? async (event: IntegrationEvent) => { await module.onEvent!(event); }
      : undefined,

    getTools: module.getTools
      ? () => module.getTools!()
      : undefined,

    getToolEntries: module.getTools
      ? () => convertToolDefinitions(module.getTools!())
      : undefined,
  };
}

/**
 * Wrap a module with TOOL_DEFS (propolis legacy) into an IncubatorPlugin.
 */
function wrapToolDefs(
  packageName: string,
  mod: { TOOL_DEFS: (workDir: string, guard: unknown, verbose?: boolean) => ToolEntry[]; destroyAllPtySessions?: () => void },
): IncubatorPlugin {
  const name = packageName.replace(/^@[^/]+\//, '');
  return {
    name,
    async start() {},
    async stop() {},
    getToolEntries(ctx: PluginContext): ToolEntry[] {
      return mod.TOOL_DEFS(ctx.workDir, ctx.guard, ctx.verbose);
    },
    destroy: mod.destroyAllPtySessions
      ? () => { mod.destroyAllPtySessions!(); }
      : undefined,
  };
}

/**
 * Convert simple ToolDefinition[] (from IntegrationModule.getTools()) to ToolEntry[].
 */
function convertToolDefinitions(tools: ToolDefinition[]): ToolEntry[] {
  return tools.map(tool => ({
    def: {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object' as const,
          properties: tool.inputSchema.properties,
          required: tool.inputSchema.required ?? [],
        },
      },
    },
    schema: {},
    handler: async (args: Record<string, unknown>): Promise<ToolResult> => {
      const result = await tool.handler(args);
      // If handler already returns ToolResult shape, pass through
      if (result && typeof result === 'object' && 'content' in (result as Record<string, unknown>)) {
        return result as ToolResult;
      }
      // Wrap raw result as text
      return {
        content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
      };
    },
  }));
}
