/**
 * HTTP + WebSocket backend that connects to the incubator REST API.
 * Uses node:http for REST calls and ws for event streaming.
 */

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import WebSocket from 'ws';
import type { AcpBackend } from './types.js';

const TIMEOUT = 5000;
const MAX_RESPONSE = 10 * 1024 * 1024;

interface BufferedEvent {
  type: string;
  data: unknown;
  agentId: string;
  seq: number;
}

export class AcpHttpBackend implements AcpBackend {
  private base: string;
  private ns: string;
  private agentId: string;
  private ws: WebSocket | null = null;
  private wsBuffer: BufferedEvent[] = [];
  private waiters: Array<{
    resolve: (events: string[]) => void;
    types: Set<string> | null;
    timer?: ReturnType<typeof setTimeout>;
  }> = [];
  private lastCursor = 0;

  constructor(serverUrl: string, namespace: string, agentId: string) {
    this.base = serverUrl.replace(/\/$/, '');
    this.ns = namespace === 'default' ? '' : `/${encodeURIComponent(namespace)}`;
    this.agentId = agentId;
  }

  // ─── REST methods ────────────────────────────────────────────

  private fetch<T = unknown>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.base}/api${this.ns}${path}`);
      const isHttps = url.protocol === 'https:';
      const reqFn = isHttps ? httpsRequest : httpRequest;

      const headers: Record<string, string> = {
        'X-Agent-Id': this.agentId,
      };
      let payload: string | undefined;
      if (body !== undefined) {
        payload = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload).toString();
      }

      const req = reqFn(url, { method, headers, timeout: TIMEOUT }, (res: IncomingMessage) => {
        let data = '';
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE) {
            req.destroy();
            reject(new Error('Response too large'));
            return;
          }
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            resolve({ ok: res.statusCode! >= 200 && res.statusCode! < 300, status: res.statusCode!, data: parsed as T });
          } catch {
            resolve({ ok: false, status: res.statusCode!, data: {} as T });
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });

      if (payload) req.write(payload);
      req.end();
    });
  }

  async publishEvent(type: string, data?: Record<string, unknown>): Promise<string> {
    const res = await this.fetch('POST', '/events', { type, data: data ?? {} });
    return JSON.stringify(res.data);
  }

  async claimResource(resource: string, value?: string): Promise<string> {
    const res = await this.fetch('POST', '/claims', { resource, value: value ?? resource });
    if (!res.ok) return `Claim rejected: ${JSON.stringify(res.data)}`;
    return JSON.stringify(res.data);
  }

  async releaseResource(resource: string): Promise<string> {
    const res = await this.fetch('DELETE', `/claims/${encodeURIComponent(resource)}`);
    return JSON.stringify(res.data);
  }

  async getState(key?: string): Promise<string> {
    const path = key ? `/state/${encodeURIComponent(key)}` : '/state';
    const res = await this.fetch('GET', path);
    return JSON.stringify(res.data);
  }

  async setState(key: string, value: unknown): Promise<string> {
    const res = await this.fetch('PUT', `/state/${encodeURIComponent(key)}`, { value });
    return JSON.stringify(res.data);
  }

  // ─── WebSocket event streaming ───────────────────────────────

  private async ensureWs(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    return new Promise((resolve, reject) => {
      const wsUrl = this.base.replace(/^http/, 'ws');
      const params = new URLSearchParams({
        namespace: this.ns ? this.ns.slice(1) : 'default',
        ...(this.lastCursor ? { since: String(this.lastCursor) } : {}),
      });

      this.ws = new WebSocket(`${wsUrl}/ws?${params}`);

      this.ws.on('open', () => resolve());
      this.ws.on('error', (err) => reject(err));

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'ping' || msg.type === 'replay_done') return;

          const event: BufferedEvent = {
            type: msg.type ?? msg.event_type ?? '',
            data: msg.data ?? msg,
            agentId: msg.agentId ?? msg.agent_id ?? '',
            seq: msg.seq ?? msg.id ?? 0,
          };

          if (event.agentId === this.agentId) return;
          if (event.seq > this.lastCursor) this.lastCursor = event.seq;

          // Check waiters
          for (let i = this.waiters.length - 1; i >= 0; i--) {
            const waiter = this.waiters[i];
            if (!waiter.types || waiter.types.has(event.type)) {
              if (waiter.timer) clearTimeout(waiter.timer);
              this.waiters.splice(i, 1);
              const formatted = `Event from ${event.agentId}: [${event.type}] ${typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}`;
              waiter.resolve([formatted]);
              return;
            }
          }

          this.wsBuffer.push(event);
        } catch {
          // Ignore malformed
        }
      });

      this.ws.on('close', () => {
        this.ws = null;
      });
    });
  }

  async waitForWake(condition: { types?: string[] | null; timeout?: number }): Promise<string[]> {
    const types = condition.types ? new Set(condition.types) : null;

    // Check buffer first
    const matchIdx = this.wsBuffer.findIndex(e => !types || types.has(e.type));
    if (matchIdx !== -1) {
      const event = this.wsBuffer.splice(matchIdx, 1)[0];
      const formatted = `Event from ${event.agentId}: [${event.type}] ${typeof event.data === 'string' ? event.data : JSON.stringify(event.data)}`;
      return [formatted];
    }

    // Connect WS if needed
    try {
      await this.ensureWs();
    } catch {
      // WS failed — fall back to polling with timeout
      if (condition.timeout && condition.timeout > 0) {
        await new Promise(r => setTimeout(r, condition.timeout));
      }
      return [];
    }

    return new Promise<string[]>((resolve) => {
      const waiter: typeof this.waiters[number] = { resolve, types };

      const timeout = condition.timeout ?? 300_000;
      if (timeout > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
          resolve([]);
        }, timeout);
      }

      this.waiters.push(waiter);
    });
  }
}
