/**
 * Browser Bridge — WebSocket endpoint for Chrome extension bridge clients.
 *
 * Uses Colony's funnel message protocol for forward compatibility.
 * No HMAC for local incubator (MVP). Auth + HMAC added when connecting to Colony.
 */

interface WebSocketLike {
  send(data: string): void;
  close(): void;
  readyState: number;
  on(event: string, cb: (...args: unknown[]) => void): void;
  OPEN: number;
}

export interface BridgeToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface BridgeClient {
  id: string;
  name: string;
  ws: WebSocketLike;
  tools: BridgeToolDef[];
  lastPong: number;
}

interface PendingCall {
  resolve: (result: { ok: boolean; data?: unknown; error?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

const TOOL_CALL_TIMEOUT = 30_000;
const PING_INTERVAL = 30_000;
const STALE_THRESHOLD = 90_000;

export class BridgeRegistry {
  private clients = new Map<string, BridgeClient>();
  private pending = new Map<string, PendingCall>();
  private callCounter = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  /** Start ping interval — call once after setup. */
  startPing(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, client] of this.clients) {
        if (now - client.lastPong > STALE_THRESHOLD) {
          this.log(`Pruning stale bridge: ${id} (${client.name})`);
          client.ws.close();
          this.unregister(id);
          continue;
        }
        if (client.ws.readyState === client.ws.OPEN) {
          client.ws.send(JSON.stringify({ type: 'ping', ts: now }));
        }
      }
    }, PING_INTERVAL);
  }

  /** Stop ping interval — call on shutdown. */
  stop(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  /** Handle a new bridge WebSocket connection. */
  handleConnection(ws: WebSocketLike): void {
    let registered = false;
    let clientId: string | null = null;

    ws.on('message', (raw: unknown) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(raw)); } catch { return; }

      if (!registered && msg.type === 'funnel_register') {
        clientId = `bridge-${crypto.randomUUID().slice(0, 8)}`;
        const name = (msg.name as string) || 'unknown';
        const tools = (msg.tools as BridgeToolDef[]) || [];

        this.clients.set(clientId, { id: clientId, name, ws, tools, lastPong: Date.now() });
        registered = true;

        ws.send(JSON.stringify({ type: 'funnel_welcome', funnelId: clientId, hiveId: 'local' }));

        const accepted = tools.map(t => t.name).filter(n => /^[a-zA-Z0-9_-]+$/.test(n));
        const rejected = tools.map(t => t.name).filter(n => !/^[a-zA-Z0-9_-]+$/.test(n));
        ws.send(JSON.stringify({ type: 'tool_ack', accepted, rejected }));

        this.log(`Registered: ${clientId} (${name}) with ${accepted.length} tools: ${accepted.join(', ')}`);
        return;
      }

      if (!registered) return;

      if (msg.type === 'tool_result') {
        const callId = msg.callId as string;
        const pending = this.pending.get(callId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(callId);
          const result = msg.result as { ok: boolean; data?: unknown; error?: string };
          pending.resolve(result);
        }
        return;
      }

      if (msg.type === 'pong') {
        if (clientId && this.clients.has(clientId)) {
          this.clients.get(clientId)!.lastPong = Date.now();
        }
        return;
      }
    });

    ws.on('close', () => {
      if (clientId) {
        this.log(`Disconnected: ${clientId}`);
        this.unregister(clientId);
      }
    });

    ws.on('error', () => {
      if (clientId) this.unregister(clientId);
    });
  }

  private unregister(id: string): void {
    this.clients.delete(id);
    // Cancel any pending calls for this bridge
    for (const [callId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: 'Bridge disconnected' });
      this.pending.delete(callId);
    }
  }

  /** Check if any bridge client is connected. */
  hasActiveBridge(): boolean {
    return this.clients.size > 0;
  }

  /** Get all tool definitions from connected bridges. */
  getToolDefs(): BridgeToolDef[] {
    const tools: BridgeToolDef[] = [];
    for (const client of this.clients.values()) {
      tools.push(...client.tools);
    }
    return tools;
  }

  /** Call a tool on a connected bridge client. Returns the result. */
  async callTool(name: string, args: Record<string, unknown>, agentId = 'local', role = 'agent'): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    // Find a client that has this tool
    let target: BridgeClient | null = null;
    for (const client of this.clients.values()) {
      if (client.tools.some(t => t.name === name) && client.ws.readyState === client.ws.OPEN) {
        target = client;
        break;
      }
    }

    if (!target) {
      return { ok: false, error: `No bridge client connected with tool '${name}'` };
    }

    const callId = `call-${++this.callCounter}-${Date.now()}`;
    const nonce = crypto.randomUUID();

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        resolve({ ok: false, error: `Tool call '${name}' timed out after ${TOOL_CALL_TIMEOUT}ms` });
      }, TOOL_CALL_TIMEOUT);

      this.pending.set(callId, { resolve, timer });

      target!.ws.send(JSON.stringify({
        type: 'tool_call',
        callId,
        tool: name,
        args,
        agentId,
        role,
        nonce,
      }));
    });
  }

  private log(msg: string): void {
    if (this.verbose) console.log(`[bridge] ${msg}`);
    else console.log(`[bridge] ${msg}`);
  }
}
