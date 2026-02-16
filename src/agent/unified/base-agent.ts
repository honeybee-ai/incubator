/**
 * BaseAgent — shared event emitter + hook management for all adapters.
 * Not an abstract class inheritance pattern. Concrete adapters compose this.
 */
import type {
  UnifiedAgent,
  AgentStatus,
  AgentContext,
  AgentResult,
  AgentHook,
  AgentEventType,
  AgentEvent,
  EventHandler,
} from './types.js';
import { HookEngine } from './hooks.js';

export abstract class BaseAgent implements UnifiedAgent {
  abstract readonly type: 'worker' | 'drone' | 'claude' | 'mock';

  readonly id: string;
  readonly role: string;
  protected _status: AgentStatus = 'idle';
  protected hooks = new HookEngine();
  private listeners = new Map<AgentEventType, Set<EventHandler>>();

  constructor(id: string, role: string) {
    this.id = id;
    this.role = role;
  }

  get status(): AgentStatus {
    return this._status;
  }

  abstract run(ctx: AgentContext): Promise<AgentResult>;
  abstract stop(reason?: string): Promise<void>;

  addHook(hook: AgentHook): void {
    this.hooks.add(hook);
  }

  removeHook(name: string): void {
    this.hooks.remove(name);
  }

  on(event: AgentEventType, handler: EventHandler): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  off(event: AgentEventType, handler: EventHandler): void {
    this.listeners.get(event)?.delete(handler);
  }

  protected emit(type: AgentEventType, data?: Record<string, unknown>): void {
    const event: AgentEvent = {
      type,
      agentId: this.id,
      role: this.role,
      timestamp: Date.now(),
      data,
    };
    const handlers = this.listeners.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(event); } catch { /* event handlers must not break agent */ }
      }
    }
  }
}
