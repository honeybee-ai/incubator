import type { Stores } from './stores/interfaces.js';

/** Heartbeat config from protocol governance (avoids spec version dependency) */
interface HeartbeatGovernance {
  heartbeat?: {
    stale_after_ms?: number;
    dead_after_ms?: number;
    auto_release_claims?: boolean;
  };
}

export interface HeartbeatConfig {
  stale_after_ms: number;
  dead_after_ms: number;
  auto_release_claims: boolean;
  check_interval_ms: number;
}

const DEFAULTS: HeartbeatConfig = {
  stale_after_ms: 30000,
  dead_after_ms: 60000,
  auto_release_claims: true,
  check_interval_ms: 10000,
};

export class HeartbeatMonitor {
  private lastActivity = new Map<string, number>();
  private staleNotified = new Set<string>();
  private deadNotified = new Set<string>();
  private config: HeartbeatConfig;
  private stores: Stores;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(stores: Stores, governance?: HeartbeatGovernance) {
    this.stores = stores;
    this.config = {
      stale_after_ms: governance?.heartbeat?.stale_after_ms ?? DEFAULTS.stale_after_ms,
      dead_after_ms: governance?.heartbeat?.dead_after_ms ?? DEFAULTS.dead_after_ms,
      auto_release_claims: governance?.heartbeat?.auto_release_claims ?? DEFAULTS.auto_release_claims,
      check_interval_ms: DEFAULTS.check_interval_ms,
    };
  }

  /** Record activity for an agent (called on every API request) */
  touch(agentId: string): void {
    this.lastActivity.set(agentId, Date.now());
    // If agent was stale, clear stale notification (they came back)
    this.staleNotified.delete(agentId);
    this.deadNotified.delete(agentId);
  }

  /** Start the periodic check timer */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.config.check_interval_ms);
  }

  /** Stop the timer */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run a single check cycle (public for testing) */
  async check(): Promise<void> {
    const now = Date.now();

    for (const [agentId, lastTime] of this.lastActivity) {
      const elapsed = now - lastTime;

      if (elapsed >= this.config.dead_after_ms && !this.deadNotified.has(agentId)) {
        await this.handleDeath(agentId);
        this.deadNotified.add(agentId);
      } else if (elapsed >= this.config.stale_after_ms && !this.staleNotified.has(agentId)) {
        await this.handleStale(agentId);
        this.staleNotified.add(agentId);
      }
    }
  }

  private async handleStale(agentId: string): Promise<void> {
    const assignment = await this.stores.roles.getByAgent(agentId);
    await this.stores.events.publish('agent.stale', {
      agent: agentId,
      role: assignment?.role,
      last_activity: new Date(this.lastActivity.get(agentId)!).toISOString(),
    }, 'server');
  }

  private async handleDeath(agentId: string): Promise<void> {
    const assignment = await this.stores.roles.getByAgent(agentId);
    const releasedClaims: string[] = [];

    if (this.config.auto_release_claims) {
      const claims = await this.stores.claims.list();
      for (const claim of claims) {
        if (claim.owner === agentId) {
          await this.stores.claims.release(claim.resource, agentId);
          releasedClaims.push(claim.resource);
        }
      }
    }

    // Remove role assignment
    await this.stores.roles.remove(agentId);

    await this.stores.events.publish('agent.died', {
      agent: agentId,
      role: assignment?.role,
      released_claims: releasedClaims,
    }, 'server');

    // Clean up tracking
    this.lastActivity.delete(agentId);
  }

  /** Get all tracked agents and their status */
  getStatus(): Array<{ agent: string; lastActivity: number; status: 'alive' | 'stale' | 'dead' }> {
    const now = Date.now();
    const result: Array<{ agent: string; lastActivity: number; status: 'alive' | 'stale' | 'dead' }> = [];
    for (const [agentId, lastTime] of this.lastActivity) {
      const elapsed = now - lastTime;
      let status: 'alive' | 'stale' | 'dead' = 'alive';
      if (elapsed >= this.config.dead_after_ms) status = 'dead';
      else if (elapsed >= this.config.stale_after_ms) status = 'stale';
      result.push({ agent: agentId, lastActivity: lastTime, status });
    }
    return result;
  }
}
