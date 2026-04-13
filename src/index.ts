#!/usr/bin/env node

declare const INCUBATOR_VERSION: string;

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { handleRestRequest } from './rest.js';
import { loadGuard, scanSnapshot } from './guard.js';
import { NamespaceRegistry } from './namespaces.js';
import { saveAllSnapshots, loadAllSnapshots } from './persistence.js';
import { LocalBus, RedisBus } from './bus.js';
import { loadSpecFile } from '@agentcoordinationprotocol/spec';
import type { NotificationBus } from './bus.js';
import type { WsManager } from './ws.js';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import type { BackendConfig } from './stores/backend.js';
import type { Redis } from './stores/redis/db.js';
import { loadIntegrationsConfig } from './integrations/index.js';
import { PluginManager } from './plugins/index.js';
import type { TopicRouterOptions } from './honeycomb.js';
import type { HoneycombTransport } from './transports/types.js';
import { RunWatcher } from './run-watcher.js';
import { BroodOrchestrator, type AgentsConfig, type MockBehavior } from './orchestrator.js';
import { WebhookManager } from './webhooks.js';
import { setLogFormat, setLogLevel, type LogFormat } from './log.js';
import { createTelemetryFromEnv, type TelemetryReporter } from '@honeybee-ai/hivemind-sdk/telemetry';
import { SessionStore } from './sessions.js';
import { TriggerEngine, type TriggerEngineConfig } from './triggers.js';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      args[key] = rest.length > 0 ? rest.join('=') : true;
    }
  }
  return args;
}

export async function main() {
  const args = parseArgs(process.argv);

  // Early exit for --version / --help
  if (args['version'] === true || args['v'] === true) {
    if (typeof INCUBATOR_VERSION !== 'undefined') {
      console.log(INCUBATOR_VERSION);
    } else {
      const { readFileSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const pkgPath = join(dirname(new URL(import.meta.url).pathname), '..', 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      console.log(pkg.version);
    }
    process.exit(0);
  }

  if (args['help'] === true || args['h'] === true) {
    console.log(`incubator - Agent coordination engine

USAGE:
  incubator [options]

OPTIONS:
  --port=N           Listen port (default: 3100)
  --mode=TYPE        'http' (default) or 'mcp'
  --brood=PATH       Brood YAML config
  --dances=PATH      Dance file (ESM module)
  --static=DIR       Serve static directory
  --protocol=PATH    Load ACP protocol YAML
  --backend=TYPE     'memory' (default), 'sqlite', or 'redis'
  --db=PATH          SQLite database path
  --redis-url=URL    Redis URL
  --persist=PATH     JSON snapshot path (memory backend)
  --tls-cert=PATH    TLS certificate (fullchain.pem)
  --tls-key=PATH     TLS private key
  --verbose          Enable debug logging
  --log-format=FMT   'text' (default) or 'json'
  --no-guard         Disable Carapace scanning
  --plugin=PKG       Load a plugin (npm package or path, repeatable)
  --version, -v      Show version
  --help, -h         Show this help`);
    process.exit(0);
  }

  // --mode=http (default) or --mode=mcp. Legacy --http flag still works.
  const mode = typeof args['mode'] === 'string' ? args['mode'] : (args['http'] === true ? 'http' : 'http');
  if (mode !== 'http' && mode !== 'mcp') {
    console.error(`[incubator] Unknown mode: ${mode}. Use 'http' (default) or 'mcp'.`);
    process.exit(1);
  }
  const isHttp = mode === 'http';
  const port = typeof args['port'] === 'string' ? parseInt(args['port'], 10) : 3100;
  const agentId = typeof args['agent-id'] === 'string' ? args['agent-id'] : undefined;
  const persistPath = typeof args['persist'] === 'string' ? args['persist'] : undefined;
  const verbose = args['verbose'] === true;
  const noGuard = args['no-guard'] === true;
  const logFormat = typeof args['log-format'] === 'string' ? args['log-format'] : 'text';
  if (logFormat !== 'text' && logFormat !== 'json') {
    console.error(`[incubator] Unknown log format: ${logFormat}. Use 'text' (default) or 'json'.`);
    process.exit(1);
  }
  setLogFormat(logFormat as LogFormat);
  if (verbose) setLogLevel('debug');

  // TLS configuration
  const tlsCert = typeof args['tls-cert'] === 'string' ? args['tls-cert'] : undefined;
  const tlsKey = typeof args['tls-key'] === 'string' ? args['tls-key'] : undefined;
  const useTls = !!(tlsCert && tlsKey);

  // Custom static directory (overrides dashboard)
  const staticDir = typeof args['static'] === 'string' ? args['static'] : undefined;

  // Brood config — preloads protocol + agent definitions for WS spawn
  const broodPath = typeof args['brood'] === 'string' ? args['brood'] : undefined;

  // Backend configuration
  const backendType = typeof args['backend'] === 'string' ? args['backend'] : 'memory';
  if (backendType !== 'memory' && backendType !== 'sqlite' && backendType !== 'redis') {
    console.error(`[incubator] Unknown backend: ${backendType}. Use 'memory', 'sqlite', or 'redis'.`);
    process.exit(1);
  }
  const dbPath = typeof args['db'] === 'string' ? args['db'] : undefined;
  const redisUrl = typeof args['redis-url'] === 'string' ? args['redis-url'] : 'redis://localhost:6379';
  const isSqlite = backendType === 'sqlite';
  const isRedis = backendType === 'redis';

  if (isSqlite && !dbPath) {
    console.error('[incubator] SQLite backend requires --db=<path>');
    process.exit(1);
  }

  if ((isSqlite || isRedis) && persistPath) {
    console.error(`[incubator] WARNING: --persist is ignored with ${backendType} backend (data is already persistent)`);
  }

  // Connect Redis client before server starts
  let redisClient: Redis | undefined;
  if (isRedis) {
    const { getRedisClient, waitForReady } = await import('./stores/redis/db.js');
    redisClient = getRedisClient(redisUrl);
    await waitForReady(redisClient);
  }

  const backendConfig: BackendConfig = { type: backendType, dbPath, redisClient };
  const skipPersistence = isSqlite || isRedis;

  // Protocol loading
  const protocolPath = typeof args['protocol'] === 'string' ? args['protocol'] : undefined;

  // Dance file loading
  const dancesPath = typeof args['dances'] === 'string' ? args['dances'] : undefined;

  // Agent orchestration (delegated from CLI's `wgl up`)
  let agentsConfig: AgentsConfig | undefined;
  if (typeof args['agents'] === 'string') {
    try {
      agentsConfig = JSON.parse(args['agents']) as AgentsConfig;
    } catch (err) {
      console.error(`[incubator] Failed to parse --agents JSON: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  // Integration loading (--integration=name or reads from config file)
  const cliIntegrations: string[] = [];
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--integration=')) {
      cliIntegrations.push(arg.slice('--integration='.length));
    }
  }
  const loadIntegrations = cliIntegrations.length > 0 || args['integrations'] === true;

  // Plugin loading (--plugin=<pkg-or-path>, repeatable)
  const cliPlugins: string[] = [];
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--plugin=')) {
      cliPlugins.push(arg.slice('--plugin='.length));
    }
  }

  const registry = new NamespaceRegistry(backendConfig);
  let sanitizeSnapshotFn: undefined | ((snapshot: import('./types.js').Snapshot) => void);
  let carapaceGuard: import('./guard.js').Guard | undefined;

  if (noGuard) {
    console.error('[incubator] WARNING: Carapace disabled — no prompt injection scanning');
  } else {
    carapaceGuard = loadGuard(verbose);
    registry.setGuard(carapaceGuard, verbose);
    sanitizeSnapshotFn = (snapshot) => scanSnapshot(snapshot, carapaceGuard!, verbose);
    console.error('[incubator] Carapace active — scanning writes, reads, and snapshots');
  }

  // Load persisted snapshots (memory backend only)
  if (persistPath && !skipPersistence) {
    const count = await loadAllSnapshots(persistPath, registry, sanitizeSnapshotFn);
    if (count > 0) {
      console.error(`[incubator] Restored ${count} namespace(s) from ${persistPath}`);
    }
  }

  // Load protocol spec if provided
  if (protocolPath) {
    try {
      const spec = await loadSpecFile(protocolPath);
      // Always load into 'default' so agents connecting without X-Namespace get it.
      // In HTTP mode, also load into the spec-name namespace for explicit namespace use.
      registry.setProtocol('default', spec);
      if (isHttp && spec.name !== 'default') {
        registry.setProtocol(spec.name, spec);
      }
      console.error(`[incubator] Protocol loaded: "${spec.title}" (${spec.name})`);
    } catch (err) {
      console.error(`[incubator] Failed to load protocol: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  // Load dance module: --dances flag > brood hive dances field
  let danceModule: import('./dances.js').DanceModule | undefined;
  let effectiveDancesPath = dancesPath;
  if (!effectiveDancesPath && broodPath) {
    // Peek into brood for dances field
    try {
      const broodPeek = readFileSync(resolvePath(broodPath), 'utf-8');
      const broodObj = (broodPath.endsWith('.json') ? JSON.parse(broodPeek) : yaml.load(broodPeek)) as Record<string, unknown>;
      const hives = (broodObj.hive ?? broodObj.hives ?? broodObj.namespaces ?? {}) as Record<string, Record<string, unknown>>;
      const firstHive = Object.values(hives)[0];
      const dancesRef = firstHive?.dances ?? firstHive?.logic ?? broodObj.dances ?? broodObj.logic;
      if (typeof dancesRef === 'string') {
        effectiveDancesPath = resolvePath(dirname(broodPath), dancesRef);
      }
    } catch { /* brood parse will fail properly later */ }
  }
  if (effectiveDancesPath) {
    const { loadDances } = await import('./dances.js');
    const absolutePath = resolvePath(effectiveDancesPath);
    const fileUrl = new URL(`file://${absolutePath}`).href;
    danceModule = await loadDances(fileUrl);
    const toolNames = [...danceModule.tools.keys()];
    console.error(`[incubator] Dances loaded: ${toolNames.join(', ')}${danceModule.inject ? ' + inject' : ''}`);
  }

  if (isSqlite) {
    console.error(`[incubator] Backend: sqlite (${dbPath})`);
  } else if (isRedis) {
    console.error(`[incubator] Backend: redis (${redisUrl})`);
  } else {
    console.error('[incubator] Backend: memory');
  }

  if (isHttp) {
    // HTTP mode: one server, multiple agent connections
    // Each session gets its own McpServer instance with a unique agent ID
    const sessions = new Map<string, { server: ReturnType<typeof createServer>; transport: StreamableHTTPServerTransport }>();

    // Create notification bus for WebSocket push
    let bus: NotificationBus;
    if (isRedis && redisClient) {
      const subClient = redisClient.duplicate();
      const { waitForReady } = await import('./stores/redis/db.js');
      await waitForReady(subClient);
      bus = new RedisBus(redisClient, subClient);
    } else {
      bus = new LocalBus();
    }
    // Cross-hive transport via IPC (set by wgl up)
    let routerOptions: TopicRouterOptions | undefined;
    const brokerSocket = process.env['HONEYCOMB_BROKER_SOCKET'];
    const hiveName = process.env['HONEYCOMB_HIVE_NAME'];
    if (brokerSocket && hiveName) {
      const hivePublishes = process.env['HONEYCOMB_PUBLISHES']?.split(',').filter(Boolean) ?? [];
      const hiveSubscribes = process.env['HONEYCOMB_SUBSCRIBES']?.split(',').filter(Boolean) ?? [];
      const { IPCTransport } = await import('./transports/ipc.js');
      const transport: HoneycombTransport = new IPCTransport({
        socketPath: brokerSocket,
        hiveName,
        publishes: hivePublishes,
        subscribes: hiveSubscribes,
      });
      await transport.connect();
      console.error(`[incubator] Honeycomb: connected to broker as "${hiveName}"`);
      routerOptions = { transport, hiveName, hivePublishes, hiveSubscribes };
    }
    registry.setBus(bus, routerOptions);

    // Session store for agent identity verification (anti-spoofing)
    const sessionStore = new SessionStore();

    // Watch for agent lifecycle events → populate RunStore
    const defaultStoresForWatcher = registry.get('default');
    const runWatcher = new RunWatcher(bus, defaultStoresForWatcher.runs);
    runWatcher.start();
    const spawnedOrchestrators: BroodOrchestrator[] = [];

    // Webhook manager — register webhooks from protocol governance
    const webhookManager = new WebhookManager(verbose);
    if (protocolPath) {
      const spec = registry.getProtocol('default');
      if (spec?.governance?.webhooks?.length) {
        webhookManager.register('default', spec.governance.webhooks, bus);
      }
    }

    const proto = useTls ? 'https' : 'http';
    const wsProto = useTls ? 'wss' : 'ws';

    // Static file serving — dashboard always at /dashboard, custom --static at /
    type RequestHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => void;
    let serveDashboard: RequestHandler | undefined;
    let serveCustom: RequestHandler | undefined;

    try {
      const sirvModule = await import('sirv');
      const sirv = (sirvModule.default ?? sirvModule) as (dir: string, opts?: { single?: boolean; dev?: boolean }) => RequestHandler;

      // Dashboard always at /dashboard
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const dashboardDir = join(__dirname, '..', 'dashboard', 'dist');
      if (existsSync(dashboardDir)) {
        serveDashboard = sirv(dashboardDir, { single: true, dev: true });
        console.error(`[incubator] Dashboard:    ${proto}://localhost:${port}/dashboard`);
      }

      // Custom static dir at /
      if (staticDir && existsSync(staticDir)) {
        serveCustom = sirv(staticDir, { single: true, dev: true });
        console.error(`[incubator] Static:       ${proto}://localhost:${port}/`);
      }
    } catch {
      // sirv not installed — static serving disabled
    }

    const requestHandler = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      // REST API routes - handled before MCP
      if (req.url?.startsWith('/api/')) {
        await handleRestRequest(req, res, registry, verbose, danceSupport, sessionStore);
        return;
      }

      const url = new URL(req.url ?? '/', `${proto}://localhost:${port}`);

      // Dashboard routes: /dashboard and /dashboard/*
      if (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) {
        if (serveDashboard) {
          // Strip /dashboard prefix so sirv serves from its root
          const originalUrl = req.url;
          req.url = url.pathname.replace(/^\/dashboard/, '') || '/';
          if (url.search) req.url += url.search;
          serveDashboard(req, res, () => {
            req.url = originalUrl;
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found.' }));
          });
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Dashboard not available.' }));
        return;
      }

      if (url.pathname !== '/mcp') {
        // Root redirect to dashboard when no custom static
        if (url.pathname === '/' && !serveCustom) {
          if (serveDashboard) {
            res.writeHead(302, { Location: '/dashboard' });
            res.end();
            return;
          }
        }
        // Custom static content at /
        if (serveCustom) {
          serveCustom(req, res, () => {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found. Use /mcp or /api/ endpoints.' }));
          });
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found. Use /mcp or /api/ endpoints.' }));
        }
        return;
      }

      // Extract namespace from X-Namespace header
      const namespace = (req.headers['x-namespace'] as string) || 'default';
      const stores = registry.get(namespace);

      // Check for existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      // New session - create transport and server
      const newAgentId = `agent_${randomUUID().slice(0, 8)}`;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          const nsLabel = namespace === 'default' ? '' : `@${namespace}`;
          console.error(`[incubator] Session ${sid} started (${newAgentId}${nsLabel})`);
          sessions.set(sid, { server: mcpServer, transport });
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          sessions.delete(sid);
          console.error(`[incubator] Session ${sid} closed`);
        }
      };

      const onSave = (persistPath && !skipPersistence) ? () => { saveAllSnapshots(persistPath, registry); } : undefined;

      const mcpServer = createServer(stores, {
        agentId: newAgentId,
        namespace,
        persistPath: skipPersistence ? undefined : persistPath,
        verbose,
        sanitizeSnapshot: sanitizeSnapshotFn,
        onSave,
        getProtocol: () => registry.getProtocol(namespace),
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    };

    const httpServer = useTls
      ? createHttpsServer({ key: readFileSync(tlsKey!), cert: readFileSync(tlsCert!) }, requestHandler)
      : createHttpServer(requestHandler);

    // Set up WebSocket push (optional: requires "ws" package)
    // setupWebSocket loads ws via import() — throws if ws not installed
    // Build dance support if dance module loaded
    let danceSupport: import('./ws.js').DanceSupport | undefined;
    if (danceModule) {
      const { buildAcpHelper } = await import('./dances.js');
      danceSupport = {
        module: danceModule,
        getState: async (ns: string) => {
          const stores = registry.get(ns);
          const entries = await stores.state.query();
          const state: Record<string, string> = {};
          for (const entry of entries) {
            state[entry.key] = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
          }
          return state;
        },
        getAcpHelper: (ns: string, agentId: string) => {
          const stores = registry.get(ns);
          return buildAcpHelper({
            publishEvent: async (_namespace, type, data, aid) => {
              const event = await stores.events.publish(type, data ?? {}, aid ?? agentId);
              bus.publish(ns, event);
            },
            claimResource: async (_namespace, resource, aid, ttl) => {
              const result = await stores.claims.claim(resource, resource, aid, ttl);
              return result.claim.resource;
            },
            releaseResource: async (_namespace, resource) => {
              await stores.claims.release(resource, agentId);
            },
            setState: async (_namespace, key, value) => {
              await stores.state.set(key, value, agentId);
            },
          }, ns, agentId);
        },
      };
    }

    let wsManager: WsManager | undefined;
    let bridgeRegistry: import('./bridge.js').BridgeRegistry | undefined;
    try {
      const { setupWebSocket } = await import('./ws.js');
      const { BridgeRegistry } = await import('./bridge.js');
      bridgeRegistry = new BridgeRegistry(verbose);
      wsManager = await setupWebSocket(httpServer, registry, bus, verbose, undefined, danceSupport, bridgeRegistry);
    } catch {
      // ws not installed or failed to load — WebSocket disabled
    }

    // Brood trigger config — populated inside brood block, consumed by TriggerEngine later
    const broodTriggerSchedule: Record<string, { every: string; action: string }> = {};
    const broodTriggerOn: Record<string, string> = {};

    // Brood config: preload agent definitions per namespace, spawn on "start" event
    if (broodPath) {
      const broodRaw = readFileSync(resolvePath(broodPath), 'utf-8');
      const broodData = (broodPath.endsWith('.json') ? JSON.parse(broodRaw) : yaml.load(broodRaw)) as Record<string, unknown>;

      // Accept hive (canonical), hives (deprecated), namespaces (alias)
      const hivesMap = (broodData.hive ?? broodData.hives ?? broodData.namespaces ?? {}) as Record<string, Record<string, unknown>>;
      const stagger = typeof broodData.stagger === 'number' ? broodData.stagger : 0;
      const broodProvider = typeof broodData.provider === 'string' ? broodData.provider : 'ollama/qwen3:8b';
      const broodEnv = (broodData.env ?? {}) as Record<string, string>;
      const broodModels = (broodData.models && typeof broodData.models === 'object' && !Array.isArray(broodData.models))
        ? broodData.models as Record<string, string> : undefined;

      // Extract sources (remote only — local paths are in the worktree already)
      const broodSources = Array.isArray(broodData.sources)
        ? (broodData.sources as unknown[]).filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
            .map(s => ({
              ...(typeof s.url === 'string' ? { url: s.url } : {}),
              ...(typeof s.git === 'string' ? { git: s.git } : {}),
              ...(typeof s.scrape === 'string' ? { scrape: s.scrape } : {}),
              ...(typeof s.as === 'string' ? { as: s.as } : {}),
              ...(typeof s.ref === 'string' ? { ref: s.ref } : {}),
              ...(typeof s.path === 'string' ? { path: s.path } : {}),
            }))
        : undefined;
      const broodIgnorePatterns = Array.isArray(broodData.ignore)
        ? (broodData.ignore as unknown[]).filter((s): s is string => typeof s === 'string')
        : undefined;

      // Resolve hive entry point (agent CLI within incubator)
      const __dirname_brood = dirname(fileURLToPath(import.meta.url));
      const hiveEntryPath = join(__dirname_brood, 'agent', 'cli.js');

      // Queen config (parse + log, actual agent spawn is follow-up)
      const queenRaw = broodData.queen as Record<string, unknown> | undefined;
      if (queenRaw && typeof queenRaw === 'object') {
        const queenProvider = typeof queenRaw.provider === 'string' ? queenRaw.provider : broodProvider;
        console.error(`[incubator] Queen configured: provider=${queenProvider}`);
      }

      // Extract trigger config from brood for TriggerEngine (wired later)
      // Top-level schedule: → TriggerEngine schedule entry "_tick"
      const scheduleRaw = broodData.schedule as Record<string, unknown> | undefined;
      if (scheduleRaw && typeof scheduleRaw.every === 'string') {
        (broodTriggerSchedule as Record<string, unknown>)['_tick'] = {
          every: scheduleRaw.every,
          action: 'publish',
          config: { type: 'schedule.tick' },
        };
        console.error(`[incubator] Schedule: tick every ${scheduleRaw.every} (via TriggerEngine)`);
      }

      // Top-level events config (canonical) or honeycomb (deprecated) → TopicRouter
      const topLevelEvents = (broodData.events ?? broodData.honeycomb) as Record<string, Record<string, unknown>> | undefined;

      // Per-namespace setup: load protocols, extract agents, register events
      interface NsAgentMap {
        namespace: string;
        agents: Array<{
          role: string;
          count?: number;
          type: 'worker' | 'drone' | 'claude' | 'mock';
          prompt: string | undefined;
          workspace: 'memfs' | 'real' | undefined;
          tools: string[] | undefined;
          mock?: MockBehavior;
          wakeOn: { types?: string[]; maxWakes?: number } | undefined;
        }>;
      }
      const namespaceAgents: NsAgentMap[] = [];

      for (const [nsName, nsConfig] of Object.entries(hivesMap)) {
        // Extract agents
        const rawAgents = ((nsConfig.agents ?? nsConfig.workers ?? []) as Array<Record<string, unknown>>).map(a => ({
          role: String(a.role ?? ''),
          count: typeof a.count === 'number' ? a.count : undefined,
          type: (a.type as 'worker' | 'drone' | 'claude' | 'mock' | undefined) ?? 'worker' as const,
          prompt: typeof a.prompt === 'string' ? a.prompt : undefined,
          workspace: (a.workspace as 'memfs' | 'real' | undefined),
          tools: Array.isArray(a.tools) ? a.tools as string[] : undefined,
          mock: a.mock ? (a.mock as MockBehavior) : undefined,
          maxIterations: typeof a.max_iterations === 'number' ? a.max_iterations : undefined,
          wakeOn: a.wake_on ? {
            types: (a.wake_on as Record<string, unknown>).types as string[] | undefined,
            maxWakes: (a.wake_on as Record<string, unknown>).max_wakes as number | undefined,
          } : undefined,
        }));

        // Load protocol from brood if specified (and not already loaded via --protocol)
        const specRef = nsConfig.acp ?? nsConfig.spec ?? nsConfig.protocol;
        if (typeof specRef === 'string' && protocolPath === undefined) {
          const specPath = resolvePath(dirname(broodPath), specRef);
          if (existsSync(specPath)) {
            const specData = await loadSpecFile(specPath);
            registry.setProtocol(nsName, specData);
            // Also set as 'default' if this is the first/only namespace
            if (Object.keys(hivesMap).length === 1) {
              registry.setProtocol('default', specData);
            }
            console.error(`[incubator] Protocol loaded for "${nsName}": ${specRef}`);

            // Auto-derive agents from spec roles when brood has no explicit agents
            if (rawAgents.length === 0 && specData.roles) {
              for (const [roleName, roleDef] of Object.entries(specData.roles)) {
                const count = typeof roleDef.agents === 'number' ? roleDef.agents : 1;
                for (let i = 0; i < count; i++) {
                  rawAgents.push({ role: roleName, count: undefined, type: 'worker' as const, prompt: undefined, workspace: undefined, tools: undefined, mock: undefined, maxIterations: undefined, wakeOn: undefined });
                }
              }
              console.error(`[incubator] Derived ${rawAgents.length} agents from spec roles for "${nsName}"`);
            }
          }
        }

        // Register per-namespace events with TopicRouter
        const nsEvents = (nsConfig.events ?? nsConfig.honeycomb ?? nsConfig.comb) as Record<string, unknown> | undefined;
        const eventsCfg = nsEvents ?? (topLevelEvents?.[nsName] as Record<string, unknown> | undefined);
        if (eventsCfg) {
          const pubs = Array.isArray(eventsCfg.publishes) ? eventsCfg.publishes.filter((x: unknown): x is string => typeof x === 'string') : [];
          const subs = Array.isArray(eventsCfg.subscribes) ? eventsCfg.subscribes.filter((x: unknown): x is string => typeof x === 'string') : [];
          const router = registry.getRouter();
          if (router) {
            for (const topic of pubs) router.publish(nsName, topic);
            for (const topic of subs) router.subscribe(nsName, topic);
            router.watch(nsName);
            if (pubs.length || subs.length) {
              console.error(`[incubator] Events for "${nsName}": publishes=[${pubs.join(',')}] subscribes=[${subs.join(',')}]`);
            }
          }
        }

        // Extract event triggers (on: { "event_type": "action" }) for TriggerEngine
        if (eventsCfg) {
          const onConfig = eventsCfg.on as Record<string, string> | undefined;
          if (onConfig && typeof onConfig === 'object') {
            for (const [eventType, action] of Object.entries(onConfig)) {
              if (typeof eventType === 'string' && typeof action === 'string') {
                broodTriggerOn[eventType] = action;
              }
            }
          }
          // Per-namespace schedule overrides top-level
          const nsSchedule = eventsCfg.schedule as Record<string, unknown> | undefined;
          if (nsSchedule && typeof nsSchedule.every === 'string') {
            broodTriggerSchedule[`_${nsName}`] = {
              every: nsSchedule.every,
              action: typeof nsSchedule.action === 'string' ? nsSchedule.action : 'publish',
            };
          }
        }

        if (rawAgents.length > 0) {
          namespaceAgents.push({ namespace: nsName, agents: rawAgents });
        }
      }

      const totalAgents = namespaceAgents.reduce((sum, ns) => sum + ns.agents.length, 0);
      const nsNames = Object.keys(hivesMap);
      console.error(`[incubator] Brood loaded: ${nsNames.length} namespace(s), ${totalAgents} agents (${broodProvider}), waiting for "start" event`);

      // Subscribe to bus — spawn orchestrators per namespace when "start" event fires
      let gameRunning = false;
      // Listen on 'default' bus for start/reset (backwards compat)
      bus.subscribe('default', (event) => {
        if (event.type === 'start' && !gameRunning) {
          gameRunning = true;
          console.error('[orchestrator] Start event received, spawning agents...');
          for (const nsEntry of namespaceAgents) {
            const nsStores = registry.get(nsEntry.namespace);
            const config: AgentsConfig = {
              provider: broodProvider,
              stagger,
              noAcp: false,
              propolisPort: 0,
              worktree: process.cwd(),
              namespace: nsEntry.namespace,
              hiveEntry: hiveEntryPath,
              tls: useTls,
              env: broodEnv,
              agents: nsEntry.agents,
              models: broodModels,
              sources: broodSources,
              ignorePatterns: broodIgnorePatterns,
            };
            const orch = new BroodOrchestrator(config, port, bus, nsStores.runs, verbose, nsStores, registry, danceSupport?.module, telemetry, pluginManager, sessionStore);
            orch.start().catch(err => {
              console.error(`[orchestrator] Spawn failed for "${nsEntry.namespace}": ${(err as Error).message}`);
            });
            spawnedOrchestrators.push(orch);
          }
        }
        // Agents completed — allow restart via trigger or manual start
        if (event.type === 'agents.complete' && gameRunning) {
          gameRunning = false;
          spawnedOrchestrators.length = 0;
          sessionStore.clear();
          console.error('[orchestrator] Agents completed — ready for restart');
        }
        // Reset — shut down running agents, clear sessions, allow new game
        if (event.type === 'reset') {
          gameRunning = false;
          for (const orch of spawnedOrchestrators) {
            orch.shutdown().catch(() => {});
          }
          spawnedOrchestrators.length = 0;
          sessionStore.clear();
          console.error('[orchestrator] Reset — agents stopped, sessions cleared, ready for new game');
        }
      });
    }

    // Initialize plugin system (replaces IntegrationManager + tool-loader)
    const defaultStoresForPlugins = registry.get('default');
    const pluginManager = new PluginManager({
      verbose,
      namespace: 'default',
      bus,
      eventStore: defaultStoresForPlugins.events,
    });

    // Extract brood plugins (if brood.yaml has a plugins: section)
    let broodPlugins: import('./plugins/index.js').BroodPluginEntry[] | undefined;
    if (broodPath) {
      try {
        const broodPeekRaw = readFileSync(resolvePath(broodPath), 'utf-8');
        const broodPeek = (broodPath.endsWith('.json') ? JSON.parse(broodPeekRaw) : yaml.load(broodPeekRaw)) as Record<string, unknown>;
        if (Array.isArray(broodPeek.plugins)) {
          broodPlugins = (broodPeek.plugins as Array<Record<string, unknown>>).map(p => ({
            package: String(p.package ?? ''),
            config: (p.config as Record<string, string>) ?? undefined,
          })).filter(p => p.package);
        }
      } catch { /* brood parse will fail properly later */ }
    }

    // Build integration config for plugins
    const intConfig = loadIntegrations ? loadIntegrationsConfig() : {};
    await pluginManager.init({
      cliPlugins: cliPlugins.length > 0 ? cliPlugins : undefined,
      broodPlugins,
      integrations: loadIntegrations ? intConfig : undefined,
      cliIntegrations: cliIntegrations.length > 0 ? cliIntegrations : undefined,
    });

    // Build tool entries for the working directory
    pluginManager.buildToolEntries(process.cwd(), carapaceGuard ?? null, verbose);

    // Register bridge browser tools if BridgeRegistry is available
    if (bridgeRegistry) {
      const handlers = pluginManager.getHandlerMap();
      const bridgeToolNames = ['browser_navigate', 'browser_click', 'browser_type', 'browser_read_page', 'browser_screenshot', 'browser_tabs'];
      for (const toolName of bridgeToolNames) {
        handlers.set(toolName, async (args: Record<string, unknown>) => {
          const result = await bridgeRegistry!.callTool(toolName, args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        });
      }
      console.error(`[incubator] Bridge:       ${bridgeToolNames.length} browser tools registered (waiting for extension)`);
    }

    const loadedPlugins = pluginManager.getLoadedNames();
    if (loadedPlugins.length > 0) {
      const toolCount = pluginManager.getToolCount();
      console.error(`[incubator] Plugins:      ${loadedPlugins.join(', ')} (${toolCount} tools)`);
    }

    // Create telemetry reporter (local-first, cloud opt-in via env vars)
    let telemetry: TelemetryReporter | undefined;
    try {
      telemetry = createTelemetryFromEnv();
      telemetry.start();
      if (telemetry.localEnabled || telemetry.nectarEnabled) {
        const parts: string[] = [];
        if (telemetry.localEnabled) parts.push('local JSONL');
        if (telemetry.nectarEnabled) parts.push('Nectar sync');
        if (telemetry.cloudEnabled) parts.push('cloud sync');
        console.error(`[incubator] Telemetry:    ${parts.join(' + ')}`);
      }
      pluginManager.setTelemetry(telemetry);
      // Wire telemetry into guard (guard was set before telemetry was created)
      if (carapaceGuard && telemetry) {
        registry.setGuard(carapaceGuard, verbose, telemetry);
        sanitizeSnapshotFn = (snapshot) => scanSnapshot(snapshot, carapaceGuard!, verbose, telemetry);
      }
      // Wire telemetry into dance support for WS metrics push
      if (danceSupport && telemetry) {
        danceSupport.telemetry = telemetry;
      }
    } catch {
      // Non-fatal — telemetry must never break the host
    }

    // ─── Trigger Engine ──────────────────────────────────────
    // Merges brood config (schedule:, events.on:) with env var config (HONEYCOMB_*).
    // Env vars override brood config for backwards compat.
    let triggerEngine: TriggerEngine | undefined;
    try {
      const honeycombTriggers = process.env['HONEYCOMB_TRIGGERS'];
      const honeycombSchedule = process.env['HONEYCOMB_SCHEDULE'];
      const honeycombCompute = process.env['HONEYCOMB_COMPUTE'];
      const honeycombRegion = process.env['HONEYCOMB_REGION'];

      // Start with brood config
      let mergedOn: Record<string, string> = { ...broodTriggerOn };
      let mergedSchedule: Record<string, { every: string; action: string }> = { ...broodTriggerSchedule };

      // Env vars override (higher priority)
      if (honeycombTriggers) {
        try {
          const envOn = JSON.parse(honeycombTriggers) as Record<string, string>;
          mergedOn = { ...mergedOn, ...envOn };
        } catch {
          console.error('[incubator] Failed to parse HONEYCOMB_TRIGGERS JSON');
        }
      }
      if (honeycombSchedule) {
        try {
          const envSchedule = JSON.parse(honeycombSchedule) as Record<string, { every: string; action: string }>;
          mergedSchedule = { ...mergedSchedule, ...envSchedule };
        } catch {
          console.error('[incubator] Failed to parse HONEYCOMB_SCHEDULE JSON');
        }
      }

      const hasTriggers = Object.keys(mergedOn).length > 0 || Object.keys(mergedSchedule).length > 0 || honeycombCompute;
      if (hasTriggers) {
        const triggerConfig: TriggerEngineConfig = {
          namespace: 'default',
          on: Object.keys(mergedOn).length > 0 ? mergedOn : undefined,
          schedule: Object.keys(mergedSchedule).length > 0 ? mergedSchedule as TriggerEngineConfig['schedule'] : undefined,
          compute: honeycombCompute,
          region: honeycombRegion,
        };

        const triggerStores = registry.get('default');
        const { buildAcpHelper: buildTriggerAcpHelper } = await import('./dances.js');
        const triggerAcp = buildTriggerAcpHelper({
          publishEvent: async (_namespace, type, data, aid) => {
            const event = await triggerStores.events.publish(type, data ?? {}, aid ?? 'trigger:system');
            bus.publish('default', event);
          },
          claimResource: async (_namespace, resource, aid, ttl) => {
            const result = await triggerStores.claims.claim(resource, resource, aid, ttl);
            return result.claim.resource;
          },
          releaseResource: async (_namespace, resource) => {
            await triggerStores.claims.release(resource, 'trigger:system');
          },
          setState: async (_namespace, key, value) => {
            await triggerStores.state.set(key, value, 'trigger:system');
          },
        }, 'default', 'trigger:system');

        triggerEngine = new TriggerEngine(triggerConfig, triggerStores, bus, triggerAcp);

        if (danceModule) {
          triggerEngine.setDanceModule(danceModule);
        }
        if (telemetry) {
          triggerEngine.setTelemetry(telemetry);
        }

        triggerEngine.start();

        const triggerCount = Object.keys(mergedOn).length;
        const scheduleCount = Object.keys(mergedSchedule).length;
        const parts: string[] = [];
        if (triggerCount > 0) parts.push(`${triggerCount} event trigger${triggerCount !== 1 ? 's' : ''}`);
        if (scheduleCount > 0) parts.push(`${scheduleCount} schedule${scheduleCount !== 1 ? 's' : ''}`);
        if (honeycombCompute) parts.push(`compute=${honeycombCompute}`);
        if (honeycombRegion) parts.push(`region=${honeycombRegion}`);
        console.error(`[incubator] Triggers:     ${parts.join(', ')}`);
      }
    } catch (err) {
      console.error(`[incubator] Trigger setup failed: ${(err as Error).message}`);
      // Non-fatal — triggers failing should not bring down the server
    }

    httpServer.listen(port, () => {
      console.error(`[incubator] ${useTls ? 'HTTPS' : 'HTTP'} server listening on port ${port}`);
      console.error(`[incubator] MCP endpoint: ${proto}://localhost:${port}/mcp`);
      console.error(`[incubator] REST API:     ${proto}://localhost:${port}/api/`);
      if (wsManager) {
        console.error(`[incubator] WebSocket:    ${wsProto}://localhost:${port}/ws`);
      } else {
        console.error(`[incubator] WebSocket:    disabled (install "ws" to enable)`);
      }
      if (persistPath && !skipPersistence) {
        console.error(`[incubator] Persistence: ${persistPath}`);
      }

      // Orchestrator mode: spawn propolis + drones (delegated from CLI)
      if (agentsConfig) {
        orchestrator = new BroodOrchestrator(
          agentsConfig, port, bus,
          defaultStoresForWatcher.runs, verbose,
          defaultStoresForWatcher, registry, danceSupport?.module, telemetry, pluginManager, sessionStore,
        );
        orchestrator.start().catch(err => {
          console.error(`[orchestrator] Fatal: ${(err as Error).message}`);
          process.exit(1);
        });
      }
    });

    let orchestrator: BroodOrchestrator | undefined;

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.error('\n[incubator] Shutting down...');
      if (triggerEngine) triggerEngine.stop();
      if (orchestrator) await orchestrator.shutdown();
      for (const orch of spawnedOrchestrators) await orch.shutdown();
      if (telemetry) await telemetry.stop();
      runWatcher.stop();
      webhookManager.close();
      await pluginManager.destroyAll();
      if (wsManager) wsManager.close();
      await bus.close();
      if (persistPath && !skipPersistence) {
        await saveAllSnapshots(persistPath, registry);
        console.error('[incubator] Snapshots saved');
      }
      if (redisClient) {
        await redisClient.quit();
        console.error('[incubator] Redis disconnected');
      }
      for (const [, session] of sessions) {
        session.server.close();
      }
      httpServer.close();
      process.exit(0);
    });
  } else {
    // Stdio mode: single agent, default namespace
    const stores = registry.get('default');

    const onSave = (persistPath && !skipPersistence) ? () => { saveAllSnapshots(persistPath!, registry); } : undefined;

    const server = createServer(stores, {
      agentId: agentId ?? 'agent_stdio',
      persistPath: skipPersistence ? undefined : persistPath,
      verbose,
      sanitizeSnapshot: sanitizeSnapshotFn,
      onSave,
      getProtocol: () => registry.getProtocol('default'),
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[incubator] Running on stdio (agent: ${agentId ?? 'agent_stdio'})`);
    if (persistPath && !skipPersistence) {
      console.error(`[incubator] Persistence: ${persistPath}`);
    }
  }
}

// Auto-execution moved to bin.ts — this file is import-only
