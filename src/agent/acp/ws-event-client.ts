import WebSocket from 'ws';
import { createTypeMatcher } from './event-matcher.js';

export interface WakeCondition {
  types?: string[] | null;  // event types to match (null = any)
  timeout?: number;         // ms, 0 = forever
}

interface BufferedEvent {
  type: string;
  data: unknown;
  agentId: string;
  seq: number;
}

/**
 * WebSocket-based event client that connects to incubator's /ws endpoint.
 * Replaces polling with push-based event delivery for reactive agents.
 */
const MAX_RECONNECTS = 10;
const MAX_RECONNECT_DELAY = 30_000;

export class WebSocketEventClient {
  private ws: WebSocket | null = null;
  private buffer: BufferedEvent[] = [];
  private agentId: string;
  private role: string;
  private serverUrl: string;
  private namespace: string;
  private lastCursor = 0;
  private closed = false;
  private reconnecting = false;
  private lastInject: string | null = null;
  private danceCallResolvers = new Map<string, (result: unknown) => void>();
  private danceTools: import('../types.js').ToolDef[] | null = null;

  /** Pending waitForWake resolvers */
  private waiters: Array<{
    resolve: (events: string[]) => void;
    matcher: ((type: string) => boolean) | null;
    timer?: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(serverUrl: string, namespace: string, agentId: string, role?: string) {
    this.serverUrl = serverUrl;
    this.namespace = namespace;
    this.agentId = agentId;
    this.role = role ?? '';
  }

  /**
   * Connect to incubator's /ws endpoint with optional replay cursor.
   */
  connect(since?: number): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Client is closed'));

    return new Promise((resolve, reject) => {
      const wsUrl = this.serverUrl.replace(/^http/, 'ws');
      const params = new URLSearchParams({
        namespace: this.namespace,
        agentId: this.agentId,
        role: this.role,
        ...(since !== undefined ? { since: String(since) } : {}),
      });

      this.ws = new WebSocket(`${wsUrl}/ws?${params}`);

      this.ws.on('open', () => resolve());
      this.ws.on('error', (err) => reject(err));

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'ping' || msg.type === 'replay_done') return;

          // Handle dance_tools — store tool definitions from server
          if (msg.type === 'dance_tools' && Array.isArray(msg.tools)) {
            this.danceTools = msg.tools;
            return;
          }

          // Handle dance_result — resolve pending callDanceTool promise
          if (msg.type === 'dance_result' && typeof msg.callId === 'string') {
            const resolver = this.danceCallResolvers.get(msg.callId);
            if (resolver) {
              this.danceCallResolvers.delete(msg.callId);
              resolver(msg.result);
            }
            return; // Don't process as regular event
          }

          // Track inject from event messages
          if (msg.type === 'event' && typeof msg.inject === 'string') {
            this.lastInject = msg.inject;
          }

          // Unwrap incubator WS envelope: { type: 'event', event: {...} }
          const inner = (msg.type === 'event' && msg.event) ? msg.event : msg;

          const event: BufferedEvent = {
            type: inner.type ?? inner.event_type ?? msg.type ?? '',
            data: inner.data ?? inner,
            agentId: inner.publishedBy ?? inner.agentId ?? inner.agent_id ?? '',
            seq: inner.id ?? inner.seq ?? msg.seq ?? 0,
          };

          // Filter own events
          if (event.agentId === this.agentId) return;

          // Track cursor
          if (event.seq > this.lastCursor) {
            this.lastCursor = event.seq;
          }

          // Check waiters first
          let consumed = false;
          for (let i = this.waiters.length - 1; i >= 0; i--) {
            const waiter = this.waiters[i];
            if (!waiter.matcher || waiter.matcher(event.type)) {
              if (waiter.timer) clearTimeout(waiter.timer);
              this.waiters.splice(i, 1);
              waiter.resolve([this.formatEvent(event)]);
              consumed = true;
              break;
            }
          }

          if (!consumed) {
            this.buffer.push(event);
          }
        } catch {
          // Ignore malformed messages
        }
      });

      this.ws.on('close', () => {
        this.ws = null;
        // Auto-reconnect if not intentionally closed
        if (!this.closed && !this.reconnecting) {
          this.reconnect();
        }
      });
    });
  }

  /**
   * Attempt to reconnect with exponential backoff.
   * Replays from last cursor to catch missed events.
   */
  private async reconnect(): Promise<void> {
    this.reconnecting = true;
    for (let attempt = 1; attempt <= MAX_RECONNECTS; attempt++) {
      if (this.closed) break;
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), MAX_RECONNECT_DELAY);
      await new Promise(r => setTimeout(r, delay));
      if (this.closed) break;
      try {
        await this.connect(this.lastCursor);
        this.reconnecting = false;
        return;
      } catch {
        // retry
      }
    }
    this.reconnecting = false;
    // Exhausted retries — waiters will stay blocked until timeout or close
  }

  /**
   * Non-blocking drain: return + clear buffer as formatted strings.
   * Same format as polling EventClient.drain().
   */
  drain(): string[] {
    if (this.buffer.length === 0) return [];
    const events = this.buffer.splice(0);
    return events.map(e => this.formatEvent(e));
  }

  /**
   * Blocking: resolve when a matching event arrives.
   * Checks buffer first (resolves immediately if match exists).
   */
  waitForWake(condition: WakeCondition): Promise<string[]> {
    const matcher = condition.types
      ? createTypeMatcher(condition.types)
      : null;

    // Check buffer first
    const matchIdx = this.buffer.findIndex(e =>
      !matcher || matcher(e.type)
    );
    if (matchIdx !== -1) {
      const event = this.buffer.splice(matchIdx, 1)[0];
      return Promise.resolve([this.formatEvent(event)]);
    }

    // If closed, return immediately
    if (this.closed || !this.ws) {
      return Promise.resolve([]);
    }

    // Register waiter
    return new Promise<string[]>((resolve) => {
      const waiter: typeof this.waiters[number] = { resolve, matcher };

      if (condition.timeout && condition.timeout > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
          resolve([]);
        }, condition.timeout);
      }

      this.waiters.push(waiter);
    });
  }

  /**
   * Get the last inject string received with an event.
   * Consumed on read — returns null on subsequent calls until a new inject arrives.
   */
  getLastInject(): string | null {
    const inject = this.lastInject;
    this.lastInject = null;
    return inject;
  }

  /**
   * Get dance tool definitions received from the server.
   * Returns null if no dance tools were sent.
   */
  getDanceTools(): import('../types.js').ToolDef[] | null {
    return this.danceTools;
  }

  /**
   * Call a dance tool on the server via WebSocket.
   * Returns a promise that resolves with the tool result.
   */
  async callDanceTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const callId = `dance_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      // Timeout after 30s
      const timer = setTimeout(() => {
        this.danceCallResolvers.delete(callId);
        reject(new Error(`Dance tool call "${tool}" timed out`));
      }, 30_000);

      this.danceCallResolvers.set(callId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });

      this.ws.send(JSON.stringify({
        type: 'dance_call',
        tool,
        args,
        callId,
        agentId: this.agentId,
        role: this.role,
      }));
    });
  }

  /**
   * Close the WebSocket and resolve all pending waiters.
   */
  close(): void {
    this.closed = true;

    // Resolve all pending waiters with empty
    for (const waiter of this.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this.waiters = [];

    // Reject all pending dance calls
    for (const [, resolver] of this.danceCallResolvers) {
      resolver({ error: 'Client closed' });
    }
    this.danceCallResolvers.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Get the last known cursor position for reconnection. */
  get cursor(): number {
    return this.lastCursor;
  }

  /** Whether the WebSocket is currently connected. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private formatEvent(e: BufferedEvent): string {
    const payload = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
    return `Event from ${e.agentId}: [${e.type}] ${payload}`;
  }
}
