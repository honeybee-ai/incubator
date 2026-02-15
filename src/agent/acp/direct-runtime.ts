/**
 * DirectRuntime — in-process ACP runtime that talks to stores directly.
 * Same public interface as AcpRuntime but bypasses HTTP/WS entirely.
 * Used by AgentPool for worker agents running inside the incubator process.
 */
import type { Stores } from '../../stores/interfaces.js';
import type { NotificationBus } from '../../bus.js';
import type { IncubatorEvent } from '../../types.js';
import type { ProtocolResponse } from './runtime.js';
import type { WakeCondition } from './ws-event-client.js';
import type { ToolDef } from '../types.js';
import type { DanceModule, DanceAcpHelper, DanceResult } from '../../dances.js';
import type { WaitSpec } from '../../waggle/types.js';
import { danceToolDefs, callDanceTool, runInject, buildAcpHelper } from '../../dances.js';
import { normalizeWait } from '../../waggle/compound.js';
import { createTypeMatcher } from './event-matcher.js';
import type { NamespaceRegistry } from '../../namespaces.js';

interface ControlStatus {
  halted: boolean;
  paused: boolean;
  reason?: string;
}

export interface DirectRuntimeConfig {
  stores: Stores;
  bus: NotificationBus;
  namespace: string;
  agentId: string;
  role: string;
  maxIterations: number;
  verbose?: boolean;
  danceModule?: DanceModule;
  protocolData?: ProtocolResponse;
  /** Registry for runtime protocol loading. */
  registry?: NamespaceRegistry;
}

export class DirectRuntime {
  private stores: Stores;
  private bus: NotificationBus;
  private namespace: string;
  private agentId: string;
  private role: string;
  private maxIterations: number;
  private verbose: boolean;
  private danceModule?: DanceModule;
  private protocolData?: ProtocolResponse;
  private registry?: NamespaceRegistry;
  private iterationCount = 0;
  private eventBuffer: string[] = [];
  private unsubscribe?: () => void;
  private claimedResources = new Set<string>();
  private cachedInject: string | null = null;
  private lastEventCursor = 0;

  constructor(config: DirectRuntimeConfig) {
    this.stores = config.stores;
    this.bus = config.bus;
    this.namespace = config.namespace;
    this.agentId = config.agentId;
    this.role = config.role;
    this.maxIterations = config.maxIterations;
    this.verbose = config.verbose ?? false;
    this.danceModule = config.danceModule;
    this.protocolData = config.protocolData;
    this.registry = config.registry;
  }

  /** Connect — register role and subscribe to bus events. */
  async connect(): Promise<void> {
    await this.stores.roles.assign(this.agentId, this.role);
    await this.stores.runs.start(this.agentId, this.role);

    // Subscribe to bus for event notifications
    this.unsubscribe = this.bus.subscribe(this.namespace, (event: IncubatorEvent) => {
      // Skip own events
      if (event.publishedBy === this.agentId) return;
      this.eventBuffer.push(formatEvent(event));
    });
  }

  /** Disconnect — release claims, unsubscribe, report. */
  async disconnect(): Promise<void> {
    // Release all claims
    for (const resource of this.claimedResources) {
      try { await this.stores.claims.release(resource, this.agentId); } catch { /* ignore */ }
    }
    this.claimedResources.clear();

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  /** Wait for a wake event matching the condition. */
  async waitForWake(condition: WakeCondition): Promise<string[]> {
    // Pre-compute inject for when we wake (runner calls getLastInject right after)
    await this.refreshInjectCache();

    // Replay missed events from the store (covers events published before bus subscription)
    await this.replayMissedEvents();

    // Check buffer first (includes both bus-delivered and store-replayed events)
    const buffered = this.drainMatchingEvents(condition.types ?? null);
    if (buffered.length > 0) return buffered;

    // Wait for new events via bus
    const timeout = condition.timeout && condition.timeout > 0 ? condition.timeout : 0;

    return new Promise<string[]>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsub: (() => void) | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (unsub) unsub();
      };

      unsub = this.bus.subscribe(this.namespace, (event: IncubatorEvent) => {
        if (event.publishedBy === this.agentId) return;

        const formatted = formatEvent(event);
        if (condition.types) {
          const matches = createTypeMatcher(condition.types);
          if (!matches(event.type)) {
            // Buffer non-matching events
            this.eventBuffer.push(formatted);
            return;
          }
        }
        cleanup();
        // Refresh inject cache on wake
        this.refreshInjectCache().then(() => resolve([formatted]));
      });

      if (timeout > 0) {
        timer = setTimeout(() => {
          cleanup();
          resolve([]);
        }, timeout);
      }
    });
  }

  /** Get last inject string from dance module. Consumed on read. */
  getLastInject(): string | null {
    const inject = this.cachedInject;
    this.cachedInject = null;
    return inject;
  }

  /** Call a dance tool directly. If handler returns `wait`, blocks until event before returning. */
  async callDanceTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.danceModule) {
      throw new Error('No dance module loaded');
    }

    const helper = this.buildDanceHelper();
    const getState = async () => this.getStateMap();
    const result: DanceResult = await callDanceTool(
      this.danceModule, tool, args, this.role, this.agentId, getState, helper,
    );

    // If handler failed or no wait returned, return as-is
    if ('error' in result || !result.wait) {
      return result;
    }

    // Normalize wait spec from handler result and block until wake
    const normalized = normalizeWait(result.wait as WaitSpec);
    if (!normalized) return result;

    // Strip wait from the result sent to LLM
    const { wait: _, ...cleanResult } = result;

    // Sync cursor + clear buffer — only wait for events AFTER this dance completed
    try {
      const { cursor } = await this.stores.events.getEvents();
      this.lastEventCursor = cursor;
    } catch { /* ignore */ }
    this.eventBuffer = [];

    let wakeEvents: string[] = [];
    if (normalized.pureDelay) {
      await new Promise(r => setTimeout(r, normalized.timeout));
    } else {
      wakeEvents = await this.waitForWake({
        types: normalized.types ?? undefined,
        timeout: normalized.timeout,
      });
    }

    // Fresh inject after wake
    const inject = this.getLastInject();

    return {
      ...cleanResult,
      wakeEvents,
      ...(inject ? { inject } : {}),
    };
  }

  /** Get dance tool definitions. */
  getDanceTools(): ToolDef[] | null {
    if (!this.danceModule) return null;
    const defs = danceToolDefs(this.danceModule);
    return defs.length > 0 ? defs : null;
  }

  /** Called before each iteration — drain events, report progress. */
  async beforeIteration(): Promise<string[]> {
    this.iterationCount++;
    await this.stores.progress.report(
      this.agentId, this.agentId, this.iterationCount / this.maxIterations,
      `Iteration ${this.iterationCount}/${this.maxIterations}`,
    );

    // Drain event buffer
    const messages = [...this.eventBuffer];
    this.eventBuffer = [];

    // Drain direct messages
    const directMessages = await this.stores.messages.getFor(this.agentId);
    for (const msg of directMessages) {
      messages.push(`Message from ${msg.from}: ${msg.content}`);
    }

    // Refresh dance inject every iteration (not just on wake)
    if (this.danceModule) {
      await this.refreshInjectCache();
    }

    return messages;
  }

  /** Called on file write — auto-claim the file. */
  async onFileWrite(path: string): Promise<string | null> {
    const result = await this.stores.claims.claim(path, path, this.agentId, 5 * 60 * 1000);
    if (result.status === 'approved') {
      this.claimedResources.add(path);
      return null;
    }
    const owner = result.claim?.owner ?? 'another agent';
    return JSON.stringify({ error: `File "${path}" is claimed by ${owner}` });
  }

  /** Called on completion — release claims, update run. */
  async onComplete(summary: string, usage?: { promptTokens: number; completionTokens: number; totalTokens: number }): Promise<void> {
    await this.stores.runs.complete(this.agentId, {
      status: 'completed',
      summary,
      iterations: this.iterationCount,
      usage,
    });

    for (const resource of this.claimedResources) {
      try { await this.stores.claims.release(resource, this.agentId); } catch { /* ignore */ }
    }
    this.claimedResources.clear();
  }

  /** Fetch protocol — returns pre-loaded data (no HTTP needed). */
  async fetchProtocol(): Promise<ProtocolResponse | null> {
    return this.protocolData ?? null;
  }

  /** Publish a coordination event. */
  async publishEvent(type: string, data: Record<string, unknown> = {}): Promise<string> {
    try {
      await this.stores.events.publish(type, data, this.agentId);
      return JSON.stringify({ published: true, type });
    } catch (err) {
      return JSON.stringify({ error: `publishEvent failed: ${(err as Error).message}` });
    }
  }

  /** Set shared state. */
  async setState(key: string, value: unknown): Promise<string> {
    try {
      await this.stores.state.set(key, value, this.agentId);
      return JSON.stringify({ ok: true, key });
    } catch (err) {
      return JSON.stringify({ error: `setState failed: ${(err as Error).message}` });
    }
  }

  /** Get shared state. Optional key for single-key or glob-pattern filtering. */
  async getState(key?: string): Promise<string> {
    try {
      if (key && key !== 'all') {
        // Single key lookup (no glob) — fast path
        if (!key.includes('*') && !key.includes('?')) {
          const entry = await this.stores.state.get(key);
          if (!entry) return JSON.stringify({ found: false, key });
          return JSON.stringify({ found: true, key, value: entry.value });
        }
        // Glob pattern — use store query
        const entries = await this.stores.state.query(key);
        const state: Record<string, unknown> = {};
        for (const entry of entries) {
          state[entry.key] = entry.value;
        }
        return JSON.stringify(state);
      }
      // All state
      const entries = await this.stores.state.query();
      const state: Record<string, unknown> = {};
      for (const entry of entries) {
        state[entry.key] = entry.value;
      }
      return JSON.stringify(state);
    } catch (err) {
      return JSON.stringify({ error: `getState failed: ${(err as Error).message}` });
    }
  }

  /** Claim a resource. */
  async claimResource(resource: string, reason?: string): Promise<string> {
    try {
      const result = await this.stores.claims.claim(resource, reason ?? resource, this.agentId, 5 * 60 * 1000);
      if (result.status === 'approved') {
        this.claimedResources.add(resource);
        return JSON.stringify({ status: 'approved', resource });
      }
      const owner = result.claim?.owner ?? 'another agent';
      return JSON.stringify({ status: 'rejected', resource, owner, message: `Already claimed by ${owner}` });
    } catch (err) {
      return JSON.stringify({ error: `claimResource failed: ${(err as Error).message}` });
    }
  }

  /** Release a claimed resource. */
  async releaseResource(resource: string): Promise<string> {
    try {
      await this.stores.claims.release(resource, this.agentId);
      this.claimedResources.delete(resource);
      return JSON.stringify({ released: true, resource });
    } catch (err) {
      return JSON.stringify({ error: `releaseResource failed: ${(err as Error).message}` });
    }
  }

  /** Load an ACP protocol spec at runtime (YAML or JSON string). */
  async loadProtocol(spec: string): Promise<string> {
    if (!this.registry) {
      return JSON.stringify({ error: 'No registry available for protocol loading' });
    }
    try {
      const { parseSpec } = await import('@agentcoordinationprotocol/spec');
      const parsed = await parseSpec(spec);
      this.registry.setProtocol(this.namespace, parsed);
      return JSON.stringify({ loaded: true, name: parsed.name, title: parsed.title });
    } catch (err) {
      return JSON.stringify({ error: `loadProtocol failed: ${(err as Error).message}` });
    }
  }

  /** Check halt/pause status. */
  async checkControl(): Promise<ControlStatus> {
    const status = this.stores.control.getStatus(this.agentId);
    return {
      halted: status.halted,
      paused: status.paused,
      reason: status.haltReason ?? status.pauseReason,
    };
  }

  /** Wait for resume after pause. */
  async waitForResume(pollIntervalMs = 2000): Promise<string> {
    while (true) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      const status = this.stores.control.getStatus(this.agentId);
      if (!status.paused) {
        return 'resumed';
      }
    }
  }

  // ─── Private helpers ──────────────────────────────────────

  /** Replay events from the store that we may have missed (published before bus subscription). */
  private async replayMissedEvents(): Promise<void> {
    try {
      const { events, cursor } = await this.stores.events.getEvents(this.lastEventCursor);
      this.lastEventCursor = cursor;
      for (const event of events) {
        if (event.publishedBy === this.agentId) continue;
        const formatted = formatEvent(event);
        // Avoid duplicates — only add if not already in buffer
        if (!this.eventBuffer.includes(formatted)) {
          this.eventBuffer.push(formatted);
        }
      }
    } catch { /* store query failed — rely on bus events */ }
  }

  private drainMatchingEvents(types: string[] | null): string[] {
    if (this.eventBuffer.length === 0) return [];

    if (!types) {
      const all = [...this.eventBuffer];
      this.eventBuffer = [];
      return all;
    }

    const matches = createTypeMatcher(types);
    const matching: string[] = [];
    const remaining: string[] = [];

    for (const msg of this.eventBuffer) {
      const m = msg.match(/\[([^\]]+)\]/);
      if (m && matches(m[1])) {
        matching.push(msg);
      } else {
        remaining.push(msg);
      }
    }

    this.eventBuffer = remaining;
    return matching;
  }

  private async getStateMap(): Promise<Record<string, string>> {
    const entries = await this.stores.state.query();
    const state: Record<string, string> = {};
    for (const entry of entries) {
      state[entry.key] = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
    }
    return state;
  }

  private buildDanceHelper(): DanceAcpHelper {
    return buildAcpHelper({
      publishEvent: async (_ns, type, data, agentId) => {
        // Note: stores.events.publish is patched by NamespaceRegistry to also bus.publish
        await this.stores.events.publish(type, data, agentId ?? this.agentId);
      },
      claimResource: async (_ns, resource, agentId, ttl) => {
        const result = await this.stores.claims.claim(resource, resource, agentId, ttl);
        return result.status;
      },
      releaseResource: async (_ns, resource) => {
        await this.stores.claims.release(resource, this.agentId);
      },
      setState: async (_ns, key, value) => {
        await this.stores.state.set(key, value, this.agentId);
      },
    }, this.namespace, this.agentId);
  }

  private async refreshInjectCache(): Promise<void> {
    if (!this.danceModule) return;
    const state = await this.getStateMap();
    this.cachedInject = runInject(this.danceModule, state, this.role, this.agentId);
  }
}

function formatEvent(event: IncubatorEvent): string {
  const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
  return `Event from ${event.publishedBy}: [${event.type}] ${data}`;
}
