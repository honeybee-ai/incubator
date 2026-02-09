#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { handleRestRequest } from './rest.js';
import { loadGuard, scanSnapshot } from './guard.js';
import { NamespaceRegistry } from './namespaces.js';
import { saveAllSnapshots, loadAllSnapshots } from './persistence.js';
import { LocalBus, RedisBus } from './bus.js';
import { loadSpecFile } from '@agentcoordinationprotocol/spec';
import { resolveProvider } from './agent/providers.js';
import { AgentRunner, preflight } from './agent/runner.js';
import type { NotificationBus } from './bus.js';
import type { WsManager } from './ws.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { BackendConfig } from './stores/backend.js';
import type { Redis } from './stores/redis/db.js';
import { IntegrationManager, loadIntegrationsConfig } from './integrations/index.js';
import type { TopicRouterOptions } from './honeycomb.js';
import type { HoneycombTransport } from './transports/types.js';

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

async function main() {
  const args = parseArgs(process.argv);
  const isHttp = args['http'] === true;
  const port = typeof args['port'] === 'string' ? parseInt(args['port'], 10) : 3100;
  const agentId = typeof args['agent-id'] === 'string' ? args['agent-id'] : undefined;
  const persistPath = typeof args['persist'] === 'string' ? args['persist'] : undefined;
  const verbose = args['verbose'] === true;
  const noGuard = args['no-guard'] === true;

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

  // Agent spawning
  const spawn = args['spawn'] === true;
  const providerShorthand = typeof args['provider'] === 'string' ? args['provider'] : 'ollama/qwen3:8b';
  const maxIterations = typeof args['max-iterations'] === 'string' ? parseInt(args['max-iterations'], 10) : 50;
  const spawnRoles = typeof args['spawn-roles'] === 'string'
    ? args['spawn-roles'].split(',').map(r => r.trim()).filter(Boolean)
    : undefined;

  // Protocol loading
  const protocolPath = typeof args['protocol'] === 'string' ? args['protocol'] : undefined;

  // Integration loading (--integration=name or reads from config file)
  const cliIntegrations: string[] = [];
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--integration=')) {
      cliIntegrations.push(arg.slice('--integration='.length));
    }
  }
  const loadIntegrations = cliIntegrations.length > 0 || args['integrations'] === true;

  const registry = new NamespaceRegistry(backendConfig);
  let sanitizeSnapshotFn: undefined | ((snapshot: import('./types.js').Snapshot) => void);

  if (noGuard) {
    console.error('[incubator] WARNING: Carapace disabled — no prompt injection scanning');
  } else {
    const guard = loadGuard(verbose);
    registry.setGuard(guard, verbose);
    sanitizeSnapshotFn = (snapshot) => scanSnapshot(snapshot, guard, verbose);
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

    // Try to load sirv for dashboard serving (optional)
    let serveDashboard: ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => void) | undefined;
    try {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const dashboardDir = join(__dirname, '..', 'dashboard', 'dist');
      if (existsSync(dashboardDir)) {
        const { createRequire } = await import('node:module');
        const require = createRequire(import.meta.url);
        const sirv = require('sirv') as (dir: string, opts?: { single?: boolean; dev?: boolean }) => (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => void;
        serveDashboard = sirv(dashboardDir, { single: true });
        console.error(`[incubator] Dashboard:    http://localhost:${port}/`);
      }
    } catch {
      // sirv not installed — dashboard disabled
    }

    const httpServer = createHttpServer(async (req, res) => {
      // REST API routes - handled before MCP
      if (req.url?.startsWith('/api/')) {
        await handleRestRequest(req, res, registry, verbose);
        return;
      }

      const url = new URL(req.url ?? '/', `http://localhost:${port}`);

      if (url.pathname !== '/mcp') {
        // Try dashboard, fall back to 404
        if (serveDashboard) {
          serveDashboard(req, res, () => {
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
    });

    // Set up WebSocket push (optional: requires "ws" package)
    // setupWebSocket calls createRequire('ws') internally — throws if ws not installed
    let wsManager: WsManager | undefined;
    try {
      const { setupWebSocket } = await import('./ws.js');
      wsManager = setupWebSocket(httpServer, registry, bus, verbose);
    } catch {
      // ws not installed or failed to load — WebSocket disabled
    }

    // Load integrations
    let integrationManager: IntegrationManager | undefined;
    if (loadIntegrations) {
      const defaultStores = registry.get('default');
      integrationManager = new IntegrationManager({
        namespace: 'default',
        bus,
        eventStore: defaultStores.events,
        verbose,
      });

      const config = loadIntegrationsConfig();
      if (cliIntegrations.length > 0) {
        // Load only CLI-specified integrations (must be in config or treated as package names)
        for (const name of cliIntegrations) {
          const entry = config[name];
          if (entry) {
            try {
              await integrationManager.load(name, entry.package, entry.config);
            } catch (err) {
              console.error(`[integrations] Failed to load "${name}": ${(err as Error).message}`);
            }
          } else {
            // Treat name as npm package name directly
            try {
              await integrationManager.load(name, name);
            } catch (err) {
              console.error(`[integrations] Failed to load "${name}": ${(err as Error).message}`);
            }
          }
        }
      } else {
        // Load all enabled integrations from config
        await integrationManager.loadFromConfig(config);
      }

      const loaded = integrationManager.getLoadedNames();
      if (loaded.length > 0) {
        console.error(`[incubator] Integrations: ${loaded.join(', ')}`);
        const tools = integrationManager.getTools();
        if (tools.length > 0) {
          console.error(`[incubator] Integration tools: ${tools.map(t => t.name).join(', ')}`);
        }
      }
    }

    httpServer.listen(port, () => {
      console.error(`[incubator] HTTP server listening on port ${port}`);
      console.error(`[incubator] MCP endpoint: http://localhost:${port}/mcp`);
      console.error(`[incubator] REST API:     http://localhost:${port}/api/`);
      if (wsManager) {
        console.error(`[incubator] WebSocket:    ws://localhost:${port}/ws`);
      } else {
        console.error(`[incubator] WebSocket:    disabled (install "ws" to enable)`);
      }
      if (persistPath && !skipPersistence) {
        console.error(`[incubator] Persistence: ${persistPath}`);
      }

      // Spawn agents if requested
      if (spawn) {
        spawnAgents(port).catch(err => {
          console.error(`[agent] Fatal: ${(err as Error).message}`);
          process.exit(1);
        });
      }
    });

    // Agent spawning helper
    let agentRunner: AgentRunner | undefined;

    async function spawnAgents(serverPort: number) {
      if (!protocolPath) {
        console.error('[agent] --spawn requires --protocol=<path>');
        process.exit(1);
      }

      const provider = resolveProvider(providerShorthand);
      await preflight(provider, verbose);

      agentRunner = new AgentRunner({
        defaultProvider: provider,
        serverUrl: `http://localhost:${serverPort}`,
        maxIterations,
        verbose,
        spawnRoles,
      });

      console.error(`[agent] Provider: ${provider.type}/${provider.model}`);
      console.error(`[agent] Max iterations: ${maxIterations}`);

      const results = await agentRunner.spawnFromProtocol(protocolPath);

      console.error('\n[agent] ═══ Results ═══');
      for (const r of results) {
        const status = r.status === 'completed' ? '✓' : '✗';
        const detail = r.error ? ` (${r.error})` : '';
        console.error(`[agent] ${status} ${r.agentId} (${r.role}): ${r.iterations} iterations${detail}`);
      }
      console.error('[agent] All agents finished');
    }

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.error('\n[incubator] Shutting down...');
      if (agentRunner) agentRunner.stop();
      if (integrationManager) await integrationManager.stopAll();
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

main().catch((err) => {
  console.error('[incubator] Fatal error:', err);
  process.exit(1);
});
