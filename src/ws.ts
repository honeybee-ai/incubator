import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { NotificationBus } from './bus.js';
import type { NamespaceRegistry } from './namespaces.js';
import type { IncubatorEvent } from './types.js';
import type { DanceModule, DanceAcpHelper } from './dances.js';
import type { TelemetryReporter } from '@honeybee-ai/hivemind-sdk/telemetry';

export interface DanceSupport {
  module: DanceModule;
  getState: (namespace: string) => Promise<Record<string, string>>;
  getAcpHelper: (namespace: string, agentId: string) => DanceAcpHelper;
  telemetry?: TelemetryReporter;
}

interface WebSocketLike {
  send(data: string): void;
  close(): void;
  readyState: number;
  on(event: string, cb: (...args: unknown[]) => void): void;
  OPEN: number;
}

interface WebSocketServerLike {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, cb: (ws: WebSocketLike) => void): void;
  close(): void;
  clients: Set<WebSocketLike>;
}

export interface WsManager {
  close(): void;
}

const PING_INTERVAL = 30_000;

async function loadWebSocketServer(): Promise<new (opts: { noServer: true }) => WebSocketServerLike> {
  const wsModule = await import('ws') as unknown as Record<string, unknown>;
  // ws@8+ ESM: named export 'WebSocketServer' is the server class.
  // m.default is the WebSocket client class (not what we need).
  const Ctor = (wsModule.WebSocketServer ?? (wsModule.default as Record<string, unknown>)?.WebSocketServer) as
    (new (opts: { noServer: true }) => WebSocketServerLike) | undefined;
  if (!Ctor) throw new Error('WebSocketServer not found in ws module');
  return Ctor;
}

export async function setupWebSocket(
  httpServer: HttpServer,
  registry: NamespaceRegistry,
  bus: NotificationBus,
  verbose?: boolean,
  /** @internal for testing — inject WebSocketServer to avoid createRequire issues in vitest */
  WebSocketServerOverride?: new (opts: { noServer: true }) => WebSocketServerLike,
  danceSupport?: DanceSupport,
): Promise<WsManager> {
  const WebSocketServer = WebSocketServerOverride ?? await loadWebSocketServer();
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, url, registry, bus, verbose, danceSupport);
    });
  });

  return {
    close() {
      wss.close();
    },
  };
}

function handleConnection(
  ws: WebSocketLike,
  url: URL,
  registry: NamespaceRegistry,
  bus: NotificationBus,
  verbose?: boolean,
  danceSupport?: DanceSupport,
): void {
  const namespace = url.searchParams.get('namespace') ?? 'default';
  const sinceParam = url.searchParams.get('since');
  const since = sinceParam !== null ? parseInt(sinceParam, 10) : undefined;
  const typesParam = url.searchParams.get('types');
  let typeFilter: Set<string> | null = typesParam ? new Set(typesParam.split(',').filter(Boolean)) : null;
  const agentId = url.searchParams.get('agentId') ?? undefined;
  const agentRole = url.searchParams.get('role') ?? undefined;

  // Buffer for events arriving during replay
  const buffer: IncubatorEvent[] = [];
  let replaying = true;
  let replayCursor = since ?? 0;

  function send(msg: unknown): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function matchesFilter(event: IncubatorEvent): boolean {
    if (!typeFilter) return true;
    return typeFilter.has(event.type);
  }

  async function sendEventWithInject(event: IncubatorEvent): Promise<void> {
    if (danceSupport && agentId && agentRole) {
      const state = await danceSupport.getState(namespace);
      const { runInject } = await import('./dances.js');
      const injectStr = runInject(danceSupport.module, state, agentRole, agentId);
      send({ type: 'event', event, ...(injectStr ? { inject: injectStr } : {}) });
    } else {
      send({ type: 'event', event });
    }
  }

  // Subscribe to bus FIRST (buffer during replay)
  const unsubscribe = bus.subscribe(namespace, (event) => {
    if (!matchesFilter(event)) return;
    if (replaying) {
      buffer.push(event);
    } else {
      sendEventWithInject(event);
    }
  });

  // Replay from store
  const stores = registry.get(namespace);
  stores.events.getEvents(since).then(async ({ events, cursor }) => {
    // Send replayed events
    for (const event of events) {
      if (matchesFilter(event)) {
        await sendEventWithInject(event);
        replayCursor = Math.max(replayCursor, event.id);
      }
    }
    replayCursor = Math.max(replayCursor, cursor);

    // Send replay_done marker
    send({ type: 'replay_done', cursor: replayCursor });

    // Send dance tool defs if dance support is available
    if (danceSupport) {
      const { danceToolDefs } = await import('./dances.js');
      send({ type: 'dance_tools', tools: danceToolDefs(danceSupport.module) });
    }

    // Flush buffer (de-dup: skip events already sent via replay)
    replaying = false;
    for (const event of buffer) {
      if (event.id > replayCursor) {
        await sendEventWithInject(event);
      }
    }
    buffer.length = 0;

    if (verbose) {
      console.error(`[incubator] WS client connected: ns=${namespace} since=${since ?? 'start'} replayed=${events.length}`);
    }
  }).catch((err) => {
    send({ type: 'error', message: 'Replay failed' });
    if (verbose) console.error('[incubator] WS replay error:', err);
    ws.close();
  });

  // Handle client messages
  ws.on('message', (raw: unknown) => {
    try {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      if (msg.type === 'subscribe') {
        typeFilter = (msg.types as string[] | null) ? new Set(msg.types as string[]) : null;
      } else if (msg.type === 'publish' && typeof msg.event === 'string') {
        // Publish an event to the bus (e.g. "start" from UI)
        // Connection-level agentId takes precedence over msg.agentId (prevents spoofing)
        const stores = registry.get(namespace);
        const publishAgentId = agentId ?? (msg.agentId as string) ?? 'ui';
        stores.events.publish(
          msg.event,
          msg.data ?? {},
          publishAgentId,
        ).then((event: IncubatorEvent) => {
          bus.publish(namespace, event);
          send({ type: 'publish_ack', eventId: event.id });
        }).catch(() => {
          send({ type: 'error', message: 'Failed to publish event' });
        });
      } else if (msg.type === 'reset') {
        // Clear all state + publish reset event (for starting new games)
        const stores = registry.get(namespace);
        stores.state.getAll().then(async (entries) => {
          for (const entry of entries) await stores.state.delete(entry.key);
          const resetEvent = await stores.events.publish('reset', {}, 'ui');
          bus.publish(namespace, resetEvent);
          send({ type: 'reset_ack' });
          if (verbose) console.error(`[incubator] WS reset: ns=${namespace} (cleared ${entries.length} keys)`);
        }).catch(() => {
          send({ type: 'error', message: 'Failed to reset state' });
        });
      } else if (msg.type === 'dance_call' && danceSupport && typeof msg.tool === 'string') {
        // Connection-level identity takes precedence over msg fields (prevents spoofing)
        const callAgentId = agentId ?? (msg.agentId as string) ?? 'unknown';
        const callRole = agentRole ?? (msg.role as string) ?? 'unknown';
        const callId = msg.callId as string;

        const getStateFn = () => danceSupport!.getState(namespace);
        const acpHelper = danceSupport!.getAcpHelper(namespace, callAgentId);

        const danceStart = Date.now();
        void import('./dances.js').then(({ callDanceTool: call }) =>
          call(
            danceSupport!.module,
            msg.tool as string,
            (msg.args as Record<string, unknown>) ?? {},
            callRole,
            callAgentId,
            getStateFn,
            acpHelper,
          )
        ).then(result => {
          // Unwrap: handlers return { result, wait? } or { error }.
          // Send only the inner result or error — strip runner metadata (wait).
          const payload = 'error' in result ? { error: result.error } : result.result;
          danceSupport?.telemetry?.record('dance_call', {
            tool: msg.tool, role: callRole, agentId: callAgentId,
            success: !('error' in result), latency_ms: Date.now() - danceStart,
          });
          send({ type: 'dance_result', callId, result: payload });
        }).catch(err => {
          danceSupport?.telemetry?.record('dance_call', {
            tool: msg.tool, role: callRole, agentId: callAgentId,
            success: false, error: (err as Error).message, latency_ms: Date.now() - danceStart,
          });
          send({ type: 'dance_result', callId, result: { error: (err as Error).message } });
        });
      }
    } catch {
      // ignore malformed messages
    }
  });

  // Ping keepalive
  const pingTimer = setInterval(() => {
    send({ type: 'ping', ts: Date.now() });
  }, PING_INTERVAL);

  // Metrics push (every 10s, if telemetry available)
  const METRICS_INTERVAL = 10_000;
  const metricsTimer = danceSupport?.telemetry ? setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    const snapshot = danceSupport!.telemetry!.getSnapshot?.();
    if (snapshot) {
      send({ type: 'metrics', data: snapshot });
    }
  }, METRICS_INTERVAL) : null;

  // Cleanup on close/error
  const cleanup = () => {
    clearInterval(pingTimer);
    if (metricsTimer) clearInterval(metricsTimer);
    unsubscribe();
    if (verbose) {
      console.error(`[incubator] WS client disconnected: ns=${namespace}`);
    }
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}
