/**
 * TriggerEngine — Event-driven and scheduled action dispatch.
 *
 * Two trigger sources, same action dispatch:
 * 1. Event triggers (on:): Subscribe to bus, match events, fire action
 * 2. Schedule triggers (schedule:): setInterval timers, fire action periodically
 *
 * Both resolve actions through: dance triggers > built-in actions.
 *
 * Loop prevention: events published by triggers use `publishedBy: "trigger:<action>"`.
 * The engine skips any event whose publishedBy starts with "trigger:".
 */

import type { NotificationBus } from './bus.js';
import type { IncubatorEvent } from './types.js';
import type { Stores } from './stores/interfaces.js';
import type { DanceModule, DanceTriggerDef, DanceAcpHelper } from './dances.js';
import type { TelemetryReporter } from '@honeybee-ai/hivemind-sdk/telemetry';
import { createTypeMatcher } from './agent/acp/event-matcher.js';

const TRIGGER_PREFIX = 'trigger:';

// ─── Duration Parsing ─────────────────────────────────────────

const DURATION_RE = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/** Parse a duration string ("30s", "15m", "1h", "2h30m") to milliseconds. */
export function parseDuration(str: string): number {
  const m = DURATION_RE.exec(str);
  if (!m || (!m[1] && !m[2] && !m[3])) {
    throw new Error(`Invalid duration "${str}" — use "30s", "15m", "1h", "2h30m"`);
  }
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  return (h * 3600 + min * 60 + s) * 1000;
}

// ─── SSRF Protection ──────────────────────────────────────────

const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.|::1|fc|fd|fe80)/i;

/** Check if a URL targets a private/loopback address (SSRF prevention). */
function isPrivateUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    const host = url.hostname;
    if (host === 'localhost' || host === '[::1]') return true;
    return PRIVATE_IP_RE.test(host);
  } catch {
    return true; // malformed URL = block
  }
}

// ─── Types ────────────────────────────────────────────────────

export interface TriggerActionConfig {
  action: string;
  config?: Record<string, string>;
}

export interface ScheduleEntry {
  every: string;
  action: string;
  config?: Record<string, string>;
}

export interface TriggerEngineConfig {
  namespace: string;
  on?: Record<string, string | TriggerActionConfig>;
  schedule?: Record<string, ScheduleEntry>;
  compute?: string;
  region?: string;
}

// ─── TriggerEngine ────────────────────────────────────────────

export class TriggerEngine {
  private namespace: string;
  private onTriggers: Map<string, TriggerActionConfig>;
  private scheduleEntries: Map<string, ScheduleEntry>;
  private scheduleTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private busUnsub?: () => void;
  private stores: Stores;
  private bus: NotificationBus;
  private acpHelper: DanceAcpHelper;
  private danceModule?: DanceModule;
  private telemetry?: TelemetryReporter;
  private matcher?: (eventType: string) => boolean;
  private compute?: string;
  private region?: string;
  private started = false;

  constructor(
    config: TriggerEngineConfig,
    stores: Stores,
    bus: NotificationBus,
    acpHelper: DanceAcpHelper,
  ) {
    this.namespace = config.namespace;
    this.stores = stores;
    this.bus = bus;
    this.acpHelper = acpHelper;
    this.compute = config.compute;
    this.region = config.region;

    // Normalize on: triggers to TriggerActionConfig
    this.onTriggers = new Map();
    if (config.on) {
      for (const [eventType, actionRaw] of Object.entries(config.on)) {
        if (typeof actionRaw === 'string') {
          this.onTriggers.set(eventType, { action: actionRaw });
        } else {
          this.onTriggers.set(eventType, actionRaw);
        }
      }
    }

    // Build event matcher from trigger keys (supports globs)
    if (this.onTriggers.size > 0) {
      this.matcher = createTypeMatcher([...this.onTriggers.keys()]);
    }

    // Schedule entries
    this.scheduleEntries = new Map();
    if (config.schedule) {
      for (const [name, entry] of Object.entries(config.schedule)) {
        this.scheduleEntries.set(name, entry);
      }
    }
  }

  /** Set dance module for custom trigger resolution. */
  setDanceModule(mod: DanceModule): void {
    this.danceModule = mod;
  }

  /** Set telemetry reporter for trigger_fired events. */
  setTelemetry(t: TelemetryReporter): void {
    this.telemetry = t;
  }

  /** Start listening for events and running schedules. */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Subscribe to bus for event triggers
    if (this.onTriggers.size > 0) {
      this.busUnsub = this.bus.subscribe(this.namespace, (event) => {
        this.handleEvent(event);
      });
    }

    // Start schedule timers
    this.startSchedules();

    // Publish container warmup signal if compute is declared
    if (this.compute && this.compute !== 'edge') {
      this.stores.events.publish(
        'container.warmup',
        { compute: this.compute, region: this.region ?? null },
        `${TRIGGER_PREFIX}warmup`,
      ).catch(() => {});
    }
  }

  /** Stop all event listeners and schedule timers. */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.busUnsub) {
      this.busUnsub();
      this.busUnsub = undefined;
    }

    this.stopSchedules();
  }

  /** Get configured event triggers (for inspection). */
  getTriggers(): Map<string, TriggerActionConfig> {
    return new Map(this.onTriggers);
  }

  /** Get configured schedules (for inspection). */
  getSchedules(): Map<string, ScheduleEntry> {
    return new Map(this.scheduleEntries);
  }

  // ─── Event Handling ──────────────────────────────────────────

  private handleEvent(event: IncubatorEvent): void {
    // Loop prevention: skip events published by triggers
    if (event.publishedBy.startsWith(TRIGGER_PREFIX)) return;

    // Check if this event type matches any trigger
    if (!this.matcher || !this.matcher(event.type)) return;

    // Resolve: exact match first, then check all patterns
    const triggerConfig = this.onTriggers.get(event.type) ?? this.findGlobMatch(event.type);
    if (!triggerConfig) return;

    // Fire-and-forget
    this.dispatchAction(triggerConfig, event).catch((err) => {
      console.error(`[triggers] Action "${triggerConfig.action}" failed: ${(err as Error).message}`);
    });
  }

  private findGlobMatch(eventType: string): TriggerActionConfig | undefined {
    for (const [pattern, config] of this.onTriggers) {
      if (pattern.includes('*')) {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*');
        if (new RegExp('^' + escaped + '$').test(eventType)) {
          return config;
        }
      }
    }
    return undefined;
  }

  // ─── Schedule Handling ──────────────────────────────────────

  private startSchedules(): void {
    for (const [name, entry] of this.scheduleEntries) {
      const ms = parseDuration(entry.every);
      const timer = setInterval(() => {
        // Create synthetic event
        const syntheticEvent: IncubatorEvent = {
          id: 0,
          type: `schedule.${name}`,
          data: { scheduleName: name, interval: entry.every },
          publishedBy: `${TRIGGER_PREFIX}schedule`,
          publishedAt: new Date().toISOString(),
        };

        const actionConfig: TriggerActionConfig = {
          action: entry.action,
          config: entry.config,
        };

        this.dispatchAction(actionConfig, syntheticEvent).catch((err) => {
          console.error(`[triggers] Schedule "${name}" action "${entry.action}" failed: ${(err as Error).message}`);
        });
      }, ms);

      this.scheduleTimers.set(name, timer);
    }
  }

  private stopSchedules(): void {
    for (const [, timer] of this.scheduleTimers) {
      clearInterval(timer);
    }
    this.scheduleTimers.clear();
  }

  // ─── Action Dispatch ────────────────────────────────────────

  private async dispatchAction(
    triggerConfig: TriggerActionConfig,
    event: IncubatorEvent,
  ): Promise<void> {
    const { action, config } = triggerConfig;

    // Record telemetry
    this.telemetry?.record('trigger_fired', {
      triggerEvent: event.type,
      action,
    });

    // Dance triggers take priority over built-in actions
    const danceTrigger = this.danceModule?.triggers?.get(action);
    if (danceTrigger) {
      await this.executeDanceTrigger(danceTrigger, event);
      return;
    }

    // Built-in actions
    switch (action) {
      case 'log':
        await this.actionLog(event, config);
        break;
      case 'halt':
        await this.actionHalt(event, config);
        break;
      case 'publish':
        await this.actionPublish(event, config);
        break;
      case 'webhook':
        await this.actionWebhook(event, config);
        break;
      case 'spawn':
        await this.actionSpawnAgents(event);
        break;
      default:
        console.error(`[triggers] Unknown action "${action}" for event "${event.type}"`);
    }
  }

  // ─── Dance Trigger Execution ────────────────────────────────

  private async executeDanceTrigger(
    trigger: DanceTriggerDef,
    event: IncubatorEvent,
  ): Promise<void> {
    const stateEntries = await this.stores.state.query();
    const state: Record<string, string> = {};
    for (const entry of stateEntries) {
      state[entry.key] = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
    }

    await trigger.handler({
      event: { type: event.type, data: event.data, publishedBy: event.publishedBy },
      state,
      acp: this.acpHelper,
    });
  }

  // ─── Built-in Actions ───────────────────────────────────────

  private async actionLog(event: IncubatorEvent, _config?: Record<string, string>): Promise<void> {
    console.error(`[triggers] log: ${event.type} (by ${event.publishedBy})`);
  }

  private async actionHalt(event: IncubatorEvent, config?: Record<string, string>): Promise<void> {
    const reason = config?.reason ?? `Trigger halt on ${event.type}`;
    await this.stores.control.halt(reason, `${TRIGGER_PREFIX}halt`);
  }

  private async actionPublish(event: IncubatorEvent, config?: Record<string, string>): Promise<void> {
    const type = config?.type;
    if (!type) {
      console.error('[triggers] publish action requires config.type');
      return;
    }
    const published = await this.stores.events.publish(
      type,
      { source: event.type, originalData: event.data },
      `${TRIGGER_PREFIX}publish`,
    );
    this.bus.publish(this.namespace, published);
  }

  private async actionSpawnAgents(event: IncubatorEvent): Promise<void> {
    // Publish 'start' on the bus — the orchestrator's bus subscriber handles the actual spawn.
    // If agents are already running, the orchestrator's gameRunning guard will skip.
    const published = await this.stores.events.publish(
      'start',
      { source: event.type, trigger: 'spawn' },
      `${TRIGGER_PREFIX}spawn`,
    );
    this.bus.publish(this.namespace, published);
    console.error(`[triggers] spawn: published 'start' (triggered by ${event.type})`);
  }

  private async actionWebhook(event: IncubatorEvent, config?: Record<string, string>): Promise<void> {
    const url = config?.url;
    if (!url) {
      console.error('[triggers] webhook action requires config.url');
      return;
    }

    // SSRF protection (R4-M4, R6-H6)
    if (isPrivateUrl(url)) {
      console.error(`[triggers] webhook blocked: private/loopback URL`);
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: event.type,
          data: event.data,
          publishedBy: event.publishedBy,
          timestamp: event.publishedAt,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        console.error(`[triggers] webhook ${url} returned ${response.status}`);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        console.error(`[triggers] webhook ${url} timed out (10s)`);
      } else {
        console.error(`[triggers] webhook ${url} failed: ${(err as Error).message}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
